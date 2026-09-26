/**
 * APPLICATION SENDER: delivery thank-you email — delivery-routes / DTE-4c.sender.
 *
 * Framework-free: ids in, AT MOST ONE customer email out. No Nest/Inngest/SDK
 * dependency — `renderToStaticMarkup` plus the injected ports are the whole
 * surface, so DTE-4c.wrapper can call `send()` inside one `step.run`.
 *
 * Fail closed BEFORE any scope: a whitespace-only id returns a non-PII
 * `skipped` result without touching scope or a port; ids are trimmed once and
 * reused for the scope and every port argument.
 *
 * Inside ONE fresh tenant scope, in order: re-read the DELIVERY_THANK_YOU
 * master/action gate (`recipients` is the STAFF list, never read) → prove the
 * exact completed-stop tuple (`Sale.deliveryStatus` defaults to DELIVERED for
 * POS, so status alone would falsely thank a counter sale) → read the persisted
 * confirmed+DELIVERED summary → resolve the recipient (tenant+sale) at send
 * time → render DTE-3 and send to `[customerEmail]` only. Nothing is cached, so
 * a retry after a mailer rejection re-evaluates gate/provenance/recipient; the
 * rejection propagates so the durable caller can retry.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DeliveryThankYouEmail,
  composeDeliveryThankYouSubject,
} from '../../notifications/email/templates/delivery-thank-you.email';
import type { IMailer } from '../../notifications/email/mailer.port';
import type { INotificationConfigRepository } from '../../notification-config/domain/notification-config.repository';
import type { TenantRunnerService } from '../../shared/tenant/tenant-runner.service';
import type { ISaleCustomerEmailLookup } from '../domain/ports/sale-customer-email.port';
import type { ISaleDeliveryStopProvenance } from '../domain/ports/sale-delivery-stop-provenance.port';
import type { ISaleDeliverySummaryReader } from '../domain/ports/sale-delivery-summary.port';

/**
 * Ids-only identity, declared locally: the application must not depend on the
 * Inngest event module, so DTE-4b can evolve the wire contract freely.
 */
export interface DeliveryThankYouSendInput {
  tenantId: string;
  saleId: string;
  routeId: string;
  stopId: string;
}

/** Terminal skip causes; never carry PII, money or an address. */
export type DeliveryThankYouSkipReason =
  | 'missing-tenant'
  | 'missing-sale'
  | 'missing-route'
  | 'missing-stop'
  | 'master-disabled'
  | 'action-disabled'
  | 'provenance-unverified'
  | 'no-summary'
  | 'no-email';

export type DeliveryThankYouSendResult =
  | { status: 'skipped'; reason: DeliveryThankYouSkipReason }
  | { status: 'sent' };

export interface DeliveryThankYouSenderDeps {
  tenantRunner: Pick<TenantRunnerService, 'runWithTenant'>;
  /** Staff-facing config read; `recipients` is never consumed here. */
  notificationConfig: Pick<INotificationConfigRepository, 'find'>;
  stopProvenance: Pick<ISaleDeliveryStopProvenance, 'hasCompletedRouteStop'>;
  summaryReader: Pick<
    ISaleDeliverySummaryReader,
    'findConfirmedDeliveredSummary'
  >;
  customerEmailLookup: Pick<ISaleCustomerEmailLookup, 'findEmailBySaleId'>;
  /** Sends to the customer only; a rejection reaches the caller. */
  mailer: Pick<IMailer, 'send'>;
  /** Already resolved merchant name; blank/omitted keeps neutral copy. */
  merchantName?: string | null;
}

function skipped(
  reason: DeliveryThankYouSkipReason,
): DeliveryThankYouSendResult {
  return { status: 'skipped', reason };
}

/** Runs one attempt. Reads no cached decision. */
export class DeliveryThankYouSender {
  constructor(private readonly deps: DeliveryThankYouSenderDeps) {}

  async send(
    input: DeliveryThankYouSendInput,
  ): Promise<DeliveryThankYouSendResult> {
    // Fail closed before scope; trim once, then use the normalized ids.
    const tenantId = input.tenantId.trim();
    if (!tenantId) return skipped('missing-tenant');
    const saleId = input.saleId.trim();
    if (!saleId) return skipped('missing-sale');
    const routeId = input.routeId.trim();
    if (!routeId) return skipped('missing-route');
    const stopId = input.stopId.trim();
    if (!stopId) return skipped('missing-stop');

    return this.deps.tenantRunner.runWithTenant(tenantId, async () => {
      const config = await this.deps.notificationConfig.find();
      if (!config.enabled) return skipped('master-disabled');
      if (!config.enabledActions.includes('DELIVERY_THANK_YOU')) {
        return skipped('action-disabled');
      }
      // `config.recipients` is the STAFF list: never a customer address.
      const proven = await this.deps.stopProvenance.hasCompletedRouteStop({
        tenantId,
        routeId,
        stopId,
        saleId,
      });
      if (!proven) return skipped('provenance-unverified');

      const summary =
        await this.deps.summaryReader.findConfirmedDeliveredSummary({
          tenantId,
          saleId,
        });
      if (!summary) return skipped('no-summary');

      const customerEmail =
        await this.deps.customerEmailLookup.findEmailBySaleId({
          tenantId,
          saleId,
        });
      if (!customerEmail) return skipped('no-email');

      const html = renderToStaticMarkup(
        DeliveryThankYouEmail({ summary, tenantName: this.deps.merchantName }),
      );

      // A rejection propagates: the durable caller retries this whole method.
      await this.deps.mailer.send({
        to: [customerEmail],
        subject: composeDeliveryThankYouSubject(),
        html,
      });
      return { status: 'sent' };
    });
  }
}
