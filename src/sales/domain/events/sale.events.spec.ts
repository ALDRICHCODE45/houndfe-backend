import {
  ReceiptConfirmedEvent,
  ReceiptRejectedEvent,
  SaleCanceledEvent,
} from './sale.events';

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

describe('sale cancellation events', () => {
  it('creates a sale.canceled payload with refund and restock facts', () => {
    const canceledAt = '2026-06-23T12:00:00.000Z';

    const event = new SaleCanceledEvent(
      'sale-1',
      'tenant-1',
      'actor-1',
      'A-2606-0001',
      'CUSTOMER_REQUEST',
      2700,
      [
        { productId: 'prod-1', variantId: null, quantity: 2 },
        { productId: 'prod-2', variantId: 'var-2', quantity: 1 },
      ],
      canceledAt,
    );

    expect(event).toEqual({
      saleId: 'sale-1',
      tenantId: 'tenant-1',
      actorId: 'actor-1',
      folio: 'A-2606-0001',
      reason: 'CUSTOMER_REQUEST',
      refundedCents: 2700,
      restockedItems: [
        { productId: 'prod-1', variantId: null, quantity: 2 },
        { productId: 'prod-2', variantId: 'var-2', quantity: 1 },
      ],
      canceledAt,
    });
  });
});
