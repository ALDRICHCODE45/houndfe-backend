import { buildSaleTimeline } from './build-sale-timeline';

describe('buildSaleTimeline', () => {
  const cashier = { id: 'cashier-1', name: 'César' };

  it('emits SALE_REGISTERED with cashier actor and register', () => {
    const result = buildSaleTimeline({
      createdAt: new Date('2026-05-08T10:00:00.000Z'),
      confirmedAt: new Date('2026-05-08T10:05:00.000Z'),
      deliveryStatus: 'DELIVERED',
      register: 'Caja secundaria',
      cashier,
      payments: [],
    });

    expect(result[0]).toEqual({
      type: 'SALE_REGISTERED',
      at: '2026-05-08T10:00:00.000Z',
      actor: cashier,
      register: 'Caja secundaria',
    });
  });

  it('emits PAYMENT_RECEIVED with payment actor data when payment user is present', () => {
    const result = buildSaleTimeline({
      createdAt: new Date('2026-05-08T10:00:00.000Z'),
      confirmedAt: new Date('2026-05-08T10:05:00.000Z'),
      deliveryStatus: 'DELIVERED',
      register: 'Caja secundaria',
      cashier,
      payments: [
        {
          method: 'TRANSFER',
          amountCents: 5000,
          reference: 'REF-123',
          createdAt: new Date('2026-05-08T10:03:00.000Z'),
          userId: 'cashier-2',
          user: { id: 'cashier-2', name: 'María' },
        },
      ],
    });

    expect(result[1]).toEqual({
      type: 'PAYMENT_RECEIVED',
      at: '2026-05-08T10:03:00.000Z',
      method: 'TRANSFER',
      amountCents: 5000,
      reference: 'REF-123',
      actor: { id: 'cashier-2', name: 'María' },
      register: 'Caja secundaria',
    });
  });

  it('falls back PAYMENT_RECEIVED actor to cashier when payment user is null', () => {
    const result = buildSaleTimeline({
      createdAt: new Date('2026-05-08T10:00:00.000Z'),
      confirmedAt: new Date('2026-05-08T10:07:00.000Z'),
      deliveryStatus: 'DELIVERED',
      register: 'Caja secundaria',
      cashier,
      payments: [
        {
          method: 'CASH',
          amountCents: 5000,
          reference: null,
          createdAt: new Date('2026-05-08T10:03:00.000Z'),
          userId: null,
          user: null,
        },
      ],
    });

    expect(result[1]).toEqual({
      type: 'PAYMENT_RECEIVED',
      at: '2026-05-08T10:03:00.000Z',
      method: 'CASH',
      amountCents: 5000,
      reference: null,
      actor: cashier,
      register: 'Caja secundaria',
    });
  });

  it('emits PRODUCTS_DELIVERED when deliveryStatus is DELIVERED', () => {
    const result = buildSaleTimeline({
      createdAt: new Date('2026-05-08T10:00:00.000Z'),
      confirmedAt: new Date('2026-05-08T10:05:00.000Z'),
      deliveryStatus: 'DELIVERED',
      register: 'Caja secundaria',
      cashier,
      payments: [],
    });

    expect(result[1]).toEqual({
      type: 'PRODUCTS_DELIVERED',
      at: '2026-05-08T10:05:00.000Z',
      actor: cashier,
      register: 'Caja secundaria',
    });
  });

  it('does not emit PRODUCTS_DELIVERED when deliveryStatus is PENDING', () => {
    const result = buildSaleTimeline({
      createdAt: new Date('2026-05-08T10:00:00.000Z'),
      confirmedAt: new Date('2026-05-08T10:05:00.000Z'),
      deliveryStatus: 'PENDING',
      register: 'Caja secundaria',
      cashier,
      payments: [],
    });

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('SALE_REGISTERED');
  });

  it('sorts events ascending by at with interleaved multiple payments', () => {
    const result = buildSaleTimeline({
      createdAt: new Date('2026-05-08T10:00:00.000Z'),
      confirmedAt: new Date('2026-05-08T10:08:00.000Z'),
      deliveryStatus: 'DELIVERED',
      register: 'Caja secundaria',
      cashier,
      payments: [
        {
          method: 'TRANSFER',
          amountCents: 4000,
          reference: 'REF-B',
          createdAt: new Date('2026-05-08T10:05:00.000Z'),
          userId: 'cashier-2',
          user: { id: 'cashier-2', name: 'María' },
        },
        {
          method: 'CASH',
          amountCents: 3000,
          reference: null,
          createdAt: new Date('2026-05-08T10:01:00.000Z'),
          userId: null,
          user: null,
        },
      ],
    });

    expect(result.map((event) => event.at)).toEqual([
      '2026-05-08T10:00:00.000Z',
      '2026-05-08T10:01:00.000Z',
      '2026-05-08T10:05:00.000Z',
      '2026-05-08T10:08:00.000Z',
    ]);
    expect(result.map((event) => event.type)).toEqual([
      'SALE_REGISTERED',
      'PAYMENT_RECEIVED',
      'PAYMENT_RECEIVED',
      'PRODUCTS_DELIVERED',
    ]);
  });
});
