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

  it('emits COMMENT event with actor, body and commentId', () => {
    const input = {
      createdAt: new Date('2026-05-08T10:00:00.000Z'),
      confirmedAt: new Date('2026-05-08T10:08:00.000Z'),
      deliveryStatus: 'DELIVERED' as const,
      register: 'Caja secundaria',
      cashier,
      payments: [],
      comments: [
        {
          id: 'comment-1',
          createdAt: new Date('2026-05-08T10:02:00.000Z'),
          body: 'Cliente pasa mañana',
          author: { id: 'seller-1', name: 'Lucía' },
        },
      ],
    };

    const result = buildSaleTimeline(
      input as Parameters<typeof buildSaleTimeline>[0],
    );

    expect(result).toContainEqual({
      type: 'COMMENT',
      at: '2026-05-08T10:02:00.000Z',
      actor: { id: 'seller-1', name: 'Lucía' },
      body: 'Cliente pasa mañana',
      commentId: 'comment-1',
    });
  });

  it('interleaves COMMENT chronologically and skips comment with missing author join', () => {
    const input = {
      createdAt: new Date('2026-05-08T10:00:00.000Z'),
      confirmedAt: new Date('2026-05-08T10:08:00.000Z'),
      deliveryStatus: 'DELIVERED' as const,
      register: 'Caja secundaria',
      cashier,
      payments: [
        {
          method: 'CASH',
          amountCents: 3000,
          reference: null,
          createdAt: new Date('2026-05-08T10:01:00.000Z'),
          userId: null,
          user: null,
        },
      ],
      comments: [
        {
          id: 'comment-1',
          createdAt: new Date('2026-05-08T10:02:00.000Z'),
          body: 'Comentario válido',
          author: { id: 'seller-1', name: 'Lucía' },
        },
        {
          id: 'comment-2',
          createdAt: new Date('2026-05-08T10:03:00.000Z'),
          body: 'No debe romper',
          author: null,
        },
      ],
    };

    const result = buildSaleTimeline(
      input as Parameters<typeof buildSaleTimeline>[0],
    );

    expect(result.map((event) => event.type)).toEqual([
      'SALE_REGISTERED',
      'PAYMENT_RECEIVED',
      'COMMENT',
      'PRODUCTS_DELIVERED',
    ]);
  });

  it('returns no COMMENT events when comments are empty', () => {
    const input = {
      createdAt: new Date('2026-05-08T10:00:00.000Z'),
      confirmedAt: new Date('2026-05-08T10:08:00.000Z'),
      deliveryStatus: 'DELIVERED' as const,
      register: 'Caja secundaria',
      cashier,
      payments: [],
      comments: [],
    };

    const result = buildSaleTimeline(
      input as Parameters<typeof buildSaleTimeline>[0],
    );

    expect(result.some((event) => event.type === 'COMMENT')).toBe(false);
  });
});

    // ── WU2 ── Custom Payment Methods (D10): PAYMENT_RECEIVED carries
    //    branded identity from the catalog snapshot. The base-category
    //    label remains the fallback when the snapshot is absent.
    describe('PAYMENT_RECEIVED — custom payment method snapshot (D10)', () => {
      const cashier = { id: 'cashier-1', name: 'César' };

      it('emits paymentMethodName + paymentMethodSubtitle when the catalog snapshot is present', () => {
        const result = buildSaleTimeline({
          createdAt: new Date('2026-05-08T10:00:00.000Z'),
          confirmedAt: new Date('2026-05-08T10:05:00.000Z'),
          deliveryStatus: 'PENDING',
          register: 'Caja secundaria',
          cashier,
          payments: [
            {
              method: 'TRANSFER',
              amountCents: 5000,
              reference: 'REF-1',
              createdAt: new Date('2026-05-08T10:03:00.000Z'),
              userId: 'cashier-2',
              user: { id: 'cashier-2', name: 'María' },
              paymentMethodName: 'Mercado Pago',
              paymentMethodSubtitle: 'Link',
            },
          ],
        });

        expect(result[1]).toEqual({
          type: 'PAYMENT_RECEIVED',
          at: '2026-05-08T10:03:00.000Z',
          method: 'TRANSFER',
          amountCents: 5000,
          reference: 'REF-1',
          actor: { id: 'cashier-2', name: 'María' },
          register: 'Caja secundaria',
          paymentMethodName: 'Mercado Pago',
          paymentMethodSubtitle: 'Link',
        });
      });

      it('emits paymentMethodName without subtitle when the catalog row has no subtitle', () => {
        const result = buildSaleTimeline({
          createdAt: new Date('2026-05-08T10:00:00.000Z'),
          confirmedAt: new Date('2026-05-08T10:05:00.000Z'),
          deliveryStatus: 'PENDING',
          register: 'Caja secundaria',
          cashier,
          payments: [
            {
              method: 'CASH',
              amountCents: 1500,
              reference: null,
              createdAt: new Date('2026-05-08T10:01:00.000Z'),
              userId: null,
              user: null,
              paymentMethodName: 'Cash USD',
              // paymentMethodSubtitle intentionally omitted (null
              // subtitle on the catalog row → not surfaced)
            },
          ],
        });

        expect(result[1]).toEqual({
          type: 'PAYMENT_RECEIVED',
          at: '2026-05-08T10:01:00.000Z',
          method: 'CASH',
          amountCents: 1500,
          reference: null,
          actor: cashier,
          register: 'Caja secundaria',
          paymentMethodName: 'Cash USD',
          paymentMethodSubtitle: undefined,
        });
      });

      it('keeps the base-category label as the fallback when the catalog snapshot is absent (legacy row)', () => {
        const result = buildSaleTimeline({
          createdAt: new Date('2026-05-08T10:00:00.000Z'),
          confirmedAt: new Date('2026-05-08T10:05:00.000Z'),
          deliveryStatus: 'PENDING',
          register: 'Caja secundaria',
          cashier,
          payments: [
            {
              method: 'CARD_CREDIT',
              amountCents: 4200,
              reference: 'AUTH-XYZ',
              createdAt: new Date('2026-05-08T10:02:00.000Z'),
              userId: 'cashier-1',
              user: { id: 'cashier-1', name: 'César' },
              // No paymentMethodName / paymentMethodSubtitle → legacy
              // row; the wire contract keeps the base-category label
              // available to clients as the fallback.
            },
          ],
        });

        const event = result[1];
        expect(event.type).toBe('PAYMENT_RECEIVED');
        expect(event.method).toBe('CARD_CREDIT');
        expect(event.amountCents).toBe(4200);
        // The base-category label is still on the wire so clients can
        // fall back to it without inferring from `method`.
        expect(event.paymentMethodName).toBeUndefined();
        expect(event.paymentMethodSubtitle).toBeUndefined();
      });

      it('interleaves a custom-name PAYMENT_RECEIVED with a legacy one in chronological order', () => {
        const result = buildSaleTimeline({
          createdAt: new Date('2026-05-08T10:00:00.000Z'),
          confirmedAt: new Date('2026-05-08T10:08:00.000Z'),
          deliveryStatus: 'PENDING',
          register: 'Caja secundaria',
          cashier,
          payments: [
            // Legacy row first (no catalog snapshot)
            {
              method: 'CASH',
              amountCents: 1000,
              reference: null,
              createdAt: new Date('2026-05-08T10:01:00.000Z'),
              userId: null,
              user: null,
            },
            // Custom row second (snapshot present)
            {
              method: 'TRANSFER',
              amountCents: 2000,
              reference: 'TRF-2',
              createdAt: new Date('2026-05-08T10:03:00.000Z'),
              userId: 'cashier-2',
              user: { id: 'cashier-2', name: 'María' },
              paymentMethodName: 'Mercado Pago',
              paymentMethodSubtitle: 'Link',
            },
          ],
        });

        const paymentEvents = result.filter(
          (event) => event.type === 'PAYMENT_RECEIVED',
        );
        expect(paymentEvents).toHaveLength(2);
        expect(paymentEvents[0].method).toBe('CASH');
        expect(paymentEvents[0].paymentMethodName).toBeUndefined();
        expect(paymentEvents[1].method).toBe('TRANSFER');
        expect(paymentEvents[1].paymentMethodName).toBe('Mercado Pago');
        expect(paymentEvents[1].paymentMethodSubtitle).toBe('Link');
      });
    });


