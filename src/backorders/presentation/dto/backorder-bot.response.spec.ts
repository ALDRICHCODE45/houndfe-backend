import {
  toBackorderBot,
  type BackorderBotSource,
} from './backorder-bot.response';

const source = (
  over: Partial<BackorderBotSource> = {},
): BackorderBotSource => ({
  id: 'bo-1',
  folio: 'BO-000012',
  status: 'WAITING',
  productId: 'p-1',
  variantId: null,
  quantity: 2,
  referencePriceCents: 114900,
  currentPriceCents: null,
  finalPriceCents: null,
  scheduledAt: new Date('2026-11-20T15:00:00.000Z'),
  estimatedAt: new Date('2026-11-27T15:00:00.000Z'),
  estimatedArrivalDays: 7,
  reservedAt: null,
  reservedUntil: null,
  reminderAt: null,
  saleId: null,
  cancelledByKind: null,
  cancelReason: null,
  product: { name: 'Croquetas Adulto Raza Grande 18 kg' },
  variant: null,
  customer: { firstName: 'Rosa' },
  tenant: { name: 'Centro' },
  ...over,
});

describe('toBackorderBot (§6.5)', () => {
  it('projects exactly the BackorderBot members, with ISO timestamps', () => {
    expect(toBackorderBot(source(), 3)).toEqual({
      id: 'bo-1',
      folio: 'BO-000012',
      status: 'WAITING',
      productId: 'p-1',
      productName: 'Croquetas Adulto Raza Grande 18 kg',
      variantId: null,
      variantName: null,
      quantity: 2,
      referencePriceCents: 114900,
      currentPriceCents: null,
      finalPriceCents: null,
      scheduledAt: '2026-11-20T15:00:00.000Z',
      estimatedAt: '2026-11-27T15:00:00.000Z',
      estimatedArrivalDays: 7,
      reservedAt: null,
      reservedUntil: null,
      reminderAt: null,
      queuePosition: 3,
      saleId: null,
      cancelledByKind: null,
      cancelReason: null,
      branchName: 'Centro',
      customerFirstName: 'Rosa',
    });
  });

  it('shows queuePosition only while WAITING', () => {
    expect(toBackorderBot(source({ status: 'WAITING' }), 1).queuePosition).toBe(
      1,
    );
    for (const status of [
      'RESERVED',
      'CONFIRMED',
      'EXPIRED',
      'CANCELLED',
    ] as const) {
      expect(toBackorderBot(source({ status }), 1).queuePosition).toBeNull();
    }
  });

  it('keeps null when no position was computed', () => {
    expect(toBackorderBot(source(), null).queuePosition).toBeNull();
  });

  it('carries the variant name and the cancellation members', () => {
    const bot = toBackorderBot(
      source({
        status: 'CANCELLED',
        variantId: 'v-1',
        variant: { name: '18 kg' },
        cancelledByKind: 'CUSTOMER',
        cancelReason: 'ya no lo necesito',
      }),
      null,
    );
    expect(bot).toMatchObject({
      variantId: 'v-1',
      variantName: '18 kg',
      cancelledByKind: 'CUSTOMER',
      cancelReason: 'ya no lo necesito',
    });
  });

  it('never exposes internal columns', () => {
    const keys = Object.keys(toBackorderBot(source(), 1));
    for (const internal of [
      'tenantId',
      'customerId',
      'idempotencyKey',
      'requestHash',
      'sourceDecisionId',
      'version',
      'etaStage',
      'reservationStage',
    ]) {
      expect(keys).not.toContain(internal);
    }
  });
});
