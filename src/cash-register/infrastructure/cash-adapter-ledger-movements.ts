/**
 * cash-register-closing / S10 — POS ledger movement planning (S6).
 *
 * Pure planning for the payments bound to a POS session: one tender per
 * non-zero payment, one change row per sale, with the catalog snapshot used
 * for a non-cash channel label. Persistence lives in the ledger module.
 */
import {
  POOLED_CASH_CHANNEL,
  assertNonNegativeCents,
  assertStorageRangeCents,
  assertValidCashMovement,
  planChangeMovement,
  resolveCashChannel,
  type CashCatalogIdentity,
  type CashMovement as DomainCashMovement,
} from '../domain';
import type { CashLedgerPayment } from '../cash-ledger.port';
import { isRecord, ledgerMethodToCashMethod } from './cash-adapter-values';

export function planLedgerPayments(
  sessionId: string,
  input: {
    saleId: string;
    payments: readonly CashLedgerPayment[];
    changeDueCents: number;
  },
): DomainCashMovement[] {
  const planned: DomainCashMovement[] = [];
  for (const payment of input.payments) {
    if (payment.amountCents === 0) {
      // Zero-value tender rows are skipped, never stored.
      continue;
    }
    assertNonNegativeCents(payment.amountCents, 'amountCents');
    assertStorageRangeCents(payment.amountCents, 'amountCents');
    const method = ledgerMethodToCashMethod(payment.method);
    const catalog = readCatalogIdentity(payment.metadataJson);
    const channel = resolveCashChannel({ method, catalog });
    const movement: DomainCashMovement = {
      sessionId,
      deltaCents: payment.amountCents,
      method,
      channelKey: channel.channelKey,
      channelLabel: channel.channelLabel,
      kind: 'SALE_PAYMENT',
      sourceType: 'PAYMENT',
      sourceId: payment.paymentId,
    };
    assertValidCashMovement(movement);
    planned.push(movement);
  }
  const change = planChangeMovement({
    sessionId,
    saleId: input.saleId,
    changeDueCents: input.changeDueCents,
    channel: POOLED_CASH_CHANNEL,
  });
  if (change) {
    planned.push(change);
  }
  return planned;
}

/** Extract the catalog snapshot used for a non-cash channel label, if any. */
function readCatalogIdentity(metadata: unknown): CashCatalogIdentity | null {
  if (!isRecord(metadata)) {
    return null;
  }
  const catalog = metadata.catalog;
  if (!isRecord(catalog)) {
    return null;
  }
  const paymentMethodId = catalog.paymentMethodId;
  const name = catalog.name;
  if (typeof paymentMethodId !== 'string' || typeof name !== 'string') {
    return null;
  }
  return { paymentMethodId, name };
}
