import { buildSaleTimeline } from './build-sale-timeline';

describe('buildSaleTimeline', () => {
  it('returns exactly 3 deterministic timeline events', () => {
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
    expect(result).toHaveLength(3);
  });

  it('falls back to confirmedAt/createdAt when payments are missing', () => {
    const result = buildSaleTimeline({
      createdAt: new Date('2026-05-08T10:00:00.000Z'),
      confirmedAt: new Date('2026-05-08T10:07:00.000Z'),
      deliveryStatus: 'PENDING',
      payments: [],
    });

    expect(result).toEqual([
      { type: 'SALE_REGISTERED', at: '2026-05-08T10:00:00.000Z' },
      { type: 'PAYMENT_RECEIVED', at: '2026-05-08T10:07:00.000Z' },
      { type: 'PRODUCTS_DELIVERED', at: '2026-05-08T10:07:00.000Z' },
    ]);
  });
});
