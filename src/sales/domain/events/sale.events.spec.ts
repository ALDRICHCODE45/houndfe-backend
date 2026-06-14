import { ReceiptConfirmedEvent, ReceiptRejectedEvent } from './sale.events';

describe('receipt review sale events', () => {
  it('creates a receipt.confirmed payload with transfer, origin, and human validation facts', () => {
    const occurredAt = '2026-06-13T12:00:00.000Z';
    const validatedAt = '2026-06-13T12:00:00.000Z';

    const event = new ReceiptConfirmedEvent(
      'receipt-1',
      'sale-1',
      'tenant-1',
      2000,
      'TRANSFER',
      { kind: 'bot', channel: 'ONLINE' },
      'reviewer-1',
      validatedAt,
      'PAID',
      occurredAt,
    );

    expect(event).toEqual({
      receiptId: 'receipt-1',
      saleId: 'sale-1',
      tenantId: 'tenant-1',
      amountCents: 2000,
      paymentMethod: 'TRANSFER',
      origin: { kind: 'bot', channel: 'ONLINE' },
      validatedByUserId: 'reviewer-1',
      validatedAt,
      resultingPaymentStatus: 'PAID',
      occurredAt,
    });
  });

  it('creates a receipt.rejected payload with the reviewer and rejection reason', () => {
    const occurredAt = '2026-06-13T12:00:00.000Z';

    const event = new ReceiptRejectedEvent(
      'receipt-1',
      'sale-1',
      'tenant-1',
      'reviewer-1',
      'Unreadable receipt',
      occurredAt,
    );

    expect(event).toEqual({
      receiptId: 'receipt-1',
      saleId: 'sale-1',
      tenantId: 'tenant-1',
      validatedByUserId: 'reviewer-1',
      reason: 'Unreadable receipt',
      occurredAt,
    });
  });
});
