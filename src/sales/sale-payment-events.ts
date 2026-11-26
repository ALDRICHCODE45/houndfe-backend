/**
 * Outbox rows of a sale payment, shared by the single-sale collection
 * (`SalesService`) and the customer collection («Cobrar todo», contract v1
 * §5.6): one `sale.payment.received` per payment row with the running paid
 * and debt amounts, and `sale.fully.paid` when the debt reaches 0. Always on
 * the caller's (transaction) client, so the rows commit with the money.
 */
import type { OutboxWriterService } from '../shared/outbox/outbox-writer.service';
import type { PersistedSalePaymentRecord } from './domain/sale.repository';

type OutboxClient = Parameters<OutboxWriterService['publish']>[0];

export async function publishSalePaymentReceivedEvents(
  outboxWriter: OutboxWriterService,
  client: OutboxClient,
  input: {
    saleId: string;
    tenantId: string;
    actorId: string | null;
    payments: PersistedSalePaymentRecord[];
    paidCents: number;
    debtCents: number;
    occurredAt: Date;
    resultingPaymentStatus?: 'PAID' | 'PARTIAL' | 'CREDIT';
    /** customer-collection / T2 — set on the rows of a «Cobrar todo». */
    collectionId?: string;
  },
): Promise<void> {
  const payments = input.payments ?? [];
  let cumulativePaidCents =
    input.paidCents - payments.reduce((sum, p) => sum + p.amountCents, 0);
  let remainingDebtCents =
    input.paidCents + input.debtCents - cumulativePaidCents;

  for (const payment of payments) {
    cumulativePaidCents += payment.amountCents;
    remainingDebtCents = Math.max(remainingDebtCents - payment.amountCents, 0);

    await outboxWriter.publish(
      client,
      input.tenantId,
      'Sale',
      input.saleId,
      'sale.payment.received',
      {
        saleId: input.saleId,
        tenantId: input.tenantId,
        actorId: input.actorId,
        paymentId: payment.paymentId,
        method: payment.method,
        amountCents: payment.amountCents,
        reference: payment.reference ?? undefined,
        occurredAt: input.occurredAt.toISOString(),
        resultingPaidCents: cumulativePaidCents,
        resultingDebtCents: remainingDebtCents,
        resultingPaymentStatus:
          input.resultingPaymentStatus ??
          (remainingDebtCents === 0 ? 'PAID' : 'PARTIAL'),
        ...(input.collectionId !== undefined
          ? { collectionId: input.collectionId }
          : {}),
      },
    );
  }
}

export async function publishSaleFullyPaidEvent(
  outboxWriter: OutboxWriterService,
  client: OutboxClient,
  input: {
    saleId: string;
    tenantId: string;
    folio: string;
    totalCents: number;
    paidAt: Date;
    /** customer-collection / T2 — set when a «Cobrar todo» settled it. */
    collectionId?: string;
  },
): Promise<void> {
  await outboxWriter.publish(
    client,
    input.tenantId,
    'Sale',
    input.saleId,
    'sale.fully.paid',
    {
      saleId: input.saleId,
      tenantId: input.tenantId,
      folio: input.folio,
      totalCents: input.totalCents,
      paidAt: input.paidAt.toISOString(),
      ...(input.collectionId !== undefined
        ? { collectionId: input.collectionId }
        : {}),
    },
  );
}
