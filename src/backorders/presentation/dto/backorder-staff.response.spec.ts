import {
  toBackorderStaff,
  type BackorderStaffSource,
} from './backorder-staff.response';

const NOW = new Date('2026-11-20T12:00:00.000Z');
const at = (iso: string) => new Date(iso);

function source(
  over: Partial<BackorderStaffSource> = {},
): BackorderStaffSource {
  return {
    id: 'b-1',
    folio: 'BO-000012',
    status: 'WAITING',
    version: 3,
    productId: 'p-1',
    variantId: null,
    quantity: 2,
    referencePriceCents: 114900,
    referencePriceListId: 'pl-1',
    currentPriceCents: null,
    finalPriceCents: null,
    scheduledAt: at('2026-11-10T10:00:00.000Z'),
    estimatedAt: at('2026-11-17T10:00:00.000Z'),
    estimatedArrivalDays: 7,
    reservedAt: null,
    reservedUntil: null,
    reminderAt: null,
    etaStage: 0,
    passedOverCount: 2,
    chatbotRequestId: 'r-1',
    sourceDecisionId: 'd-1',
    confirmedAt: null,
    saleId: null,
    cancelledAt: null,
    cancelReason: null,
    cancelledByKind: null,
    cancelledByUserId: null,
    expiredAt: null,
    product: { name: 'Croquetas' },
    variant: null,
    customer: {
      id: 'c-1',
      firstName: 'Rosa',
      lastName: 'Pérez',
      phoneCountryCode: '52',
      phone: '5512345678',
    },
    tenant: { name: 'Centro' },
    cancelledBy: null,
    sale: null,
    ...over,
  };
}

const project = (over: Partial<BackorderStaffSource> = {}, extra = {}) =>
  toBackorderStaff(source(over), {
    queuePosition: 4,
    productImageUrl: 'https://img/p.png',
    now: NOW,
    ...extra,
  });

describe('toBackorderStaff (contract v1 §9.1)', () => {
  it('carries every BackorderBot field plus the staff additions', () => {
    expect(project()).toEqual({
      id: 'b-1',
      folio: 'BO-000012',
      status: 'WAITING',
      productId: 'p-1',
      productName: 'Croquetas',
      variantId: null,
      variantName: null,
      quantity: 2,
      referencePriceCents: 114900,
      currentPriceCents: null,
      finalPriceCents: null,
      scheduledAt: '2026-11-10T10:00:00.000Z',
      estimatedAt: '2026-11-17T10:00:00.000Z',
      estimatedArrivalDays: 7,
      reservedAt: null,
      reservedUntil: null,
      reminderAt: null,
      queuePosition: 4,
      saleId: null,
      sourceDecisionId: 'd-1',
      cancelledByKind: null,
      cancelReason: null,
      branchName: 'Centro',
      customerFirstName: 'Rosa',
      phoneCountryCode: '52',
      phone: '5512345678',
      version: 3,
      customer: { id: 'c-1', name: 'Rosa Pérez', phone: '+525512345678' },
      origin: 'CHATBOT',
      chatbotRequestId: 'r-1',
      productImageUrl: 'https://img/p.png',
      priceListId: 'pl-1',
      confirmedAt: null,
      cancelledAt: null,
      expiredAt: null,
      cancelledBy: null,
      saleStatus: null,
      etaOverdue: false,
      passedOverCount: 2,
    });
  });

  it('names the customer from first and last name, phone null without one', () => {
    const noLast = project({
      customer: {
        id: 'c-1',
        firstName: 'Rosa',
        lastName: null,
        phoneCountryCode: null,
        phone: null,
      },
    });
    expect(noLast.customer).toEqual({ id: 'c-1', name: 'Rosa', phone: null });
  });

  it('queuePosition only while WAITING', () => {
    expect(project({ status: 'RESERVED' }).queuePosition).toBeNull();
    expect(project({ status: 'WAITING' }).queuePosition).toBe(4);
  });

  it('etaOverdue only for WAITING + etaStage 2 + estimatedAt in the past', () => {
    const past = at('2026-11-19T00:00:00.000Z');
    const future = at('2026-11-25T00:00:00.000Z');
    expect(project({ etaStage: 2, estimatedAt: past }).etaOverdue).toBe(true);
    expect(project({ etaStage: 2, estimatedAt: future }).etaOverdue).toBe(
      false,
    );
    expect(project({ etaStage: 1, estimatedAt: past }).etaOverdue).toBe(false);
    expect(project({ etaStage: 0, estimatedAt: past }).etaOverdue).toBe(false);
    expect(
      project({ status: 'RESERVED', etaStage: 2, estimatedAt: past })
        .etaOverdue,
    ).toBe(false);
    expect(project({ etaStage: 2, estimatedAt: NOW }).etaOverdue).toBe(false);
  });

  it('exposes the lifecycle timestamps, the canceller and the sale status', () => {
    const staff = project({
      status: 'CANCELLED',
      cancelledAt: at('2026-11-20T11:00:00.000Z'),
      cancelledByKind: 'STAFF',
      cancelledByUserId: 'u-1',
      cancelledBy: { id: 'u-1', name: 'Ana Pérez' },
      cancelReason: 'Sin contacto',
    });
    expect(staff).toMatchObject({
      cancelledAt: '2026-11-20T11:00:00.000Z',
      cancelledByKind: 'STAFF',
      cancelledBy: { id: 'u-1', name: 'Ana Pérez' },
      cancelReason: 'Sin contacto',
    });
    const confirmed = project({
      status: 'CONFIRMED',
      confirmedAt: at('2026-11-20T10:00:00.000Z'),
      saleId: 's-1',
      sale: { status: 'CANCELED' },
      expiredAt: null,
    });
    expect(confirmed).toMatchObject({
      confirmedAt: '2026-11-20T10:00:00.000Z',
      saleId: 's-1',
      saleStatus: 'CANCELED',
    });
    expect(
      project({ status: 'EXPIRED', expiredAt: at('2026-11-20T09:00:00.000Z') })
        .expiredAt,
    ).toBe('2026-11-20T09:00:00.000Z');
  });

  it('keeps a customer cancel without canceller', () => {
    expect(
      project({ status: 'CANCELLED', cancelledByKind: 'CUSTOMER' }).cancelledBy,
    ).toBeNull();
  });
});
