import { buildSaleTimeline } from './build-sale-timeline';

describe('buildSaleTimeline', () => {
  it('emits one PAYMENT_RECEIVED event per payment sorted by createdAt', () => {
    const result = buildSaleTimeline({
      createdAt: new Date('2026-05-08T10:00:00.000Z'),
      confirmedAt: new Date('2026-05-08T10:05:00.000Z'),
      deliveryStatus: 'DELIVERED',
      payments: [
        { createdAt: new Date('2026-05-08T10:04:00.000Z') },
        { createdAt: new Date('2026-05-08T10:03:00.000Z') },
      ],
    });

    expect(result).toEqual([
      { type: 'SALE_REGISTERED', at: '2026-05-08T10:00:00.000Z' },
      { type: 'PAYMENT_RECEIVED', at: '2026-05-08T10:03:00.000Z' },
      { type: 'PAYMENT_RECEIVED', at: '2026-05-08T10:04:00.000Z' },
      { type: 'PRODUCTS_DELIVERED', at: '2026-05-08T10:05:00.000Z' },
    ]);
    expect(result).toHaveLength(4);
  });

  it('omits PAYMENT_RECEIVED when a credit sale has no payments', () => {
    const result = buildSaleTimeline({
      createdAt: new Date('2026-05-08T10:00:00.000Z'),
      confirmedAt: new Date('2026-05-08T10:07:00.000Z'),
      deliveryStatus: 'PENDING',
      payments: [],
    });

    expect(result).toEqual([
      { type: 'SALE_REGISTERED', at: '2026-05-08T10:00:00.000Z' },
      { type: 'PRODUCTS_DELIVERED', at: '2026-05-08T10:07:00.000Z' },
    ]);
    expect(result).toHaveLength(2);
  });

  it('keeps backward-compatible single payment behavior', () => {
    const result = buildSaleTimeline({
      createdAt: new Date('2026-05-08T10:00:00.000Z'),
      confirmedAt: new Date('2026-05-08T10:05:00.000Z'),
      deliveryStatus: 'DELIVERED',
      payments: [{ createdAt: new Date('2026-05-08T10:03:00.000Z') }],
    });

    expect(result).toEqual([
      { type: 'SALE_REGISTERED', at: '2026-05-08T10:00:00.000Z' },
      { type: 'PAYMENT_RECEIVED', at: '2026-05-08T10:03:00.000Z' },
      { type: 'PRODUCTS_DELIVERED', at: '2026-05-08T10:05:00.000Z' },
    ]);
  });
});
