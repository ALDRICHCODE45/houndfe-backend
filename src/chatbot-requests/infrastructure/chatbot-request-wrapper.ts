/**
 * Wraps the legacy human flows in a `ChatbotRequest` (human-intervention unit
 * 3; contract §2.1, §2.3, §2.4). It is the single hook the existing intake and
 * resolve paths call, always on the caller's transaction:
 *
 *   creation   `wrapHumanDecision`, `wrapZoneRequest`, `wrapReceipt`: insert
 *              the 1:1 request, its CREATED event and the customer group in
 *              the same transaction as the wrapped row, so a rolled-back
 *              insert leaves no request.
 *   legacy     `lockLegacy` takes the open wrapping requests BEFORE the old
 *              code touches the wrapped row, and `closeLegacy` resolves them
 *              after it succeeded, so a request and its wrapped row never
 *              disagree and both entry points lock in one order: request row,
 *              wrapped row, group (docs/chatbot-requests-model.md).
 *
 * The staff `resolve` command closes the requests itself and runs the old use
 * cases inside `suppressLegacyClose`, so nothing is closed twice.
 *
 * Wrapper rows use `source = WRAP:<TABLE>` and the wrapped id as
 * `sourceRequestId`; the bot's own intake (unit 5) uses its credential source.
 */
import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { CUSTOMER_REPLY_WINDOW_MS } from '../../delivery-zones/domain/delivery-zone.policy';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { toState } from '../application/chatbot-request-commands.service';
import { canonicalPhone, phoneLookupVariants } from '../domain/canonical-phone';
import { actorDisplayName } from '../domain/actor-display-name';
import { closeWrapped } from '../domain/chatbot-request.commands';
import {
  allocateFolio,
  applyRequestPatch,
  assertTenantLinks,
  lockOpenWrapping,
  refreshCustomerGroup,
  refreshCustomerGroups,
  type TenantClient,
  type WrappedLink,
} from './chatbot-request-writes';

export const WRAP_SOURCE = {
  humanDecision: 'WRAP:HUMAN_DECISION',
  deliveryZoneRequest: 'WRAP:DELIVERY_ZONE_REQUEST',
  receiptEvidence: 'WRAP:RECEIPT_EVIDENCE',
} as const;

const SUMMARY_MAX = 140;
const ASSERT_TX = 'ChatbotRequestWrapper must run inside a transaction';

interface CustomerLink {
  customerKey: string | null;
  customerId: string | null;
  ambiguousCustomer: boolean;
  phoneCountryCode: string | null;
  phone: string | null;
}

const NO_CUSTOMER: CustomerLink = {
  customerKey: null,
  customerId: null,
  ambiguousCustomer: false,
  phoneCountryCode: null,
  phone: null,
};

interface NewWrappedRequest {
  subtype: 'RESTOCK' | 'EXPIRATION' | 'DELIVERY_ZONE' | 'TRANSFER_RECEIPT';
  source: string;
  wrappedId: string;
  fallbackKey: string;
  summary: string;
  context: Record<string, string | number | null>;
  link: CustomerLink;
  wrapped: {
    humanDecisionId?: string;
    deliveryZoneRequestId?: string;
    receiptEvidenceId?: string;
  };
  conversationRef?: string;
  lastCustomerMessageAt?: Date;
}

@Injectable()
export class ChatbotRequestWrapper {
  private readonly suppressed = new AsyncLocalStorage<true>();

  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /** Runs `work` (a legacy use case) without its close hook; see file doc. */
  suppressLegacyClose<T>(work: () => Promise<T>): Promise<T> {
    return this.suppressed.run(true, work);
  }

  private get hooksOff(): boolean {
    return this.suppressed.getStore() === true;
  }

  private get tx(): TenantClient {
    if (!this.tenantPrisma.isInTransaction()) throw new Error(ASSERT_TX);
    return this.tenantPrisma.getClient();
  }

  // ---------------------------------------------------------------- creation

  /** RESTOCK / EXPIRATION carry no customer (§2.3): one group per decision. */
  async wrapHumanDecision(decision: {
    id: string;
    type: 'RESTOCK' | 'EXPIRATION';
    productId: string;
    productName: string;
    variantId: string | null;
  }): Promise<void> {
    await this.insert({
      subtype: decision.type,
      source: WRAP_SOURCE.humanDecision,
      wrappedId: decision.id,
      fallbackKey: `unknown:${decision.id}`,
      summary: `${decision.type === 'RESTOCK' ? 'Stock' : 'Caducidad'}: ${decision.productName}`,
      context: { productId: decision.productId, variantId: decision.variantId },
      link: NO_CUSTOMER,
      wrapped: { humanDecisionId: decision.id },
    });
  }

  /** Only requesters that wait for a human; an EXISTING_ZONE one is resolved. */
  async wrapZoneRequest(request: {
    id: string;
    zipCode: string;
    conversationRef: string;
    customerPhoneCountryCode: string;
    customerPhone: string;
    lastCustomerMessageAt: Date;
  }): Promise<void> {
    await this.insert({
      subtype: 'DELIVERY_ZONE',
      source: WRAP_SOURCE.deliveryZoneRequest,
      wrappedId: request.id,
      fallbackKey: `unknown:${request.id}`,
      summary: `Zona de entrega ${request.zipCode}`,
      context: { zipCode: request.zipCode },
      link: await this.linkByPhone(
        request.customerPhoneCountryCode,
        request.customerPhone,
      ),
      wrapped: { deliveryZoneRequestId: request.id },
      conversationRef: request.conversationRef,
      lastCustomerMessageAt: request.lastCustomerMessageAt,
    });
  }

  /** The customer comes from `Sale.customerId` and that customer's phone. */
  async wrapReceipt(receipt: { id: string; saleId: string }): Promise<void> {
    const { tx } = this;
    const tenantId = this.tenantPrisma.getTenantId();
    const sale = await tx.sale.findFirst({
      where: { id: receipt.saleId, tenantId },
      select: {
        folio: true,
        customerId: true,
        customer: { select: { phoneCountryCode: true, phone: true } },
      },
    });
    const phoneKey =
      sale?.customer?.phoneCountryCode && sale.customer.phone
        ? this.normalizedPhone(
            sale.customer.phoneCountryCode,
            sale.customer.phone,
          )
        : null;
    // The sale names its customer, so this is not a phone inference (R1).
    const link: CustomerLink = {
      ...NO_CUSTOMER,
      ...(phoneKey ?? {}),
      customerId: sale?.customerId ?? null,
    };
    await this.insert({
      subtype: 'TRANSFER_RECEIPT',
      source: WRAP_SOURCE.receiptEvidence,
      wrappedId: receipt.id,
      fallbackKey: `unknown:${receipt.id}`,
      summary: `Comprobante de transferencia${sale?.folio ? ` ${sale.folio}` : ''}`,
      context: { saleId: receipt.saleId },
      link,
      wrapped: { receiptEvidenceId: receipt.id },
    });
  }

  private normalizedPhone(
    countryCode: string,
    phone: string,
  ): Pick<CustomerLink, 'customerKey' | 'phoneCountryCode' | 'phone'> | null {
    const key = canonicalPhone(countryCode, phone);
    if (!key) return null;
    const digits = countryCode.replace(/\D/g, '');
    const cc = digits === '521' ? '52' : digits;
    return {
      customerKey: key,
      phoneCountryCode: cc,
      phone: key.slice(cc.length),
    };
  }

  /**
   * R1: the customer is linked only when the canonical key maps to exactly one
   * `Customer`; with several the request stays unlinked and marked ambiguous,
   * and staff links it by hand.
   */
  private async linkByPhone(
    countryCode: string,
    phone: string,
  ): Promise<CustomerLink> {
    const normalized = this.normalizedPhone(countryCode, phone);
    if (!normalized?.customerKey) return NO_CUSTOMER;
    const tenantId = this.tenantPrisma.getTenantId();
    const variants = phoneLookupVariants(countryCode, phone);
    const hits = await this.tx.customer.findMany({
      where: {
        tenantId,
        phoneCountryCode: { in: variants.countryCodes },
        phone: { in: variants.phones },
      },
      select: { id: true, phoneCountryCode: true, phone: true },
      take: 10,
    });
    const same = hits.filter(
      (hit) =>
        hit.phoneCountryCode !== null &&
        hit.phone !== null &&
        canonicalPhone(hit.phoneCountryCode, hit.phone) ===
          normalized.customerKey,
    );
    return {
      ...normalized,
      customerId: same.length === 1 ? same[0].id : null,
      ambiguousCustomer: same.length > 1,
    };
  }

  /**
   * Lock order: the wrapped row was inserted by the caller; the folio comes
   * after every read and lock, and the group last.
   */
  private async insert(input: NewWrappedRequest): Promise<void> {
    const { tx } = this;
    const tenantId = this.tenantPrisma.getTenantId();
    const customerKey = input.link.customerKey ?? input.fallbackKey;
    await assertTenantLinks(tx, tenantId, {
      customerId: input.link.customerId,
      ...input.wrapped,
    });
    const request = await tx.chatbotRequest.create({
      data: {
        tenantId,
        folio: await allocateFolio(tx, tenantId),
        kind: 'DECISION',
        subtype: input.subtype,
        customerKey,
        customerId: input.link.customerId,
        ambiguousCustomer: input.link.ambiguousCustomer,
        phoneCountryCode: input.link.phoneCountryCode,
        phone: input.link.phone,
        conversationRef: input.conversationRef ?? null,
        ...(input.lastCustomerMessageAt
          ? {
              lastCustomerMessageAt: input.lastCustomerMessageAt,
              whatsappWindowClosesAt: new Date(
                input.lastCustomerMessageAt.getTime() +
                  CUSTOMER_REPLY_WINDOW_MS,
              ),
            }
          : {}),
        summary: input.summary.slice(0, SUMMARY_MAX),
        context: input.context,
        source: input.source,
        sourceRequestId: input.wrappedId,
        ...input.wrapped,
      },
      select: { id: true },
    });
    await tx.chatbotRequestEvent.create({
      data: {
        tenantId,
        requestId: request.id,
        type: 'CREATED',
        actorKind: 'SYSTEM',
        toStatus: 'NEW',
        version: 1,
        data: { subtype: input.subtype, wrapped: true },
      },
    });
    await refreshCustomerGroup(tx, tenantId, customerKey);
  }

  // ----------------------------------------------------------- legacy routes

  /** The legacy receipt routes only know the id; the name may be empty. */
  private async nameOf(userId: string): Promise<string> {
    const user = await this.tx.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });
    if (!user) throw new Error('legacy resolve by an unknown user');
    return actorDisplayName(user);
  }

  /** Call before the legacy code writes the wrapped row (lock order). */
  async lockLegacy(link: WrappedLink): Promise<void> {
    if (this.hooksOff) return;
    await lockOpenWrapping(this.tx, this.tenantPrisma.getTenantId(), link);
  }

  /**
   * Call after the legacy resolve wrote the wrapped row. Resolves every open
   * wrapping request with the legacy action (the whole zone set, for a zone).
   * An already closed request is left alone.
   */
  async closeLegacy(
    link: WrappedLink,
    actor: { userId: string; displayName?: string },
    action: string,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    if (this.hooksOff) return;
    const { tx } = this;
    const tenantId = this.tenantPrisma.getTenantId();
    const rows = await lockOpenWrapping(tx, tenantId, link);
    if (rows.length === 0) return;
    const displayName =
      actor.displayName?.trim() || (await this.nameOf(actor.userId));
    const now = new Date();
    for (const row of rows) {
      const closed = closeWrapped(toState(row), {
        actor: { userId: actor.userId, displayName },
        action,
        now,
        resolution: { action, via: 'LEGACY_ROUTE', ...details },
        data: { via: 'LEGACY_ROUTE' },
      });
      if (!closed.ok) continue;
      await applyRequestPatch(tx, tenantId, row, closed.patch, closed.event);
    }
    await refreshCustomerGroups(
      tx,
      tenantId,
      rows.map((row) => row.customerKey),
    );
  }
}
