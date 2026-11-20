import {
  asBackorderNotice,
  BACKORDER_EXPIRED_NOTICE,
  BACKORDER_NOTICE_GRANTS,
  BACKORDER_NOTICE_TYPES,
  BACKORDER_RESERVED_NOTICE,
  BACKORDER_UNDELIVERED_NOTICE,
  backorderExpiredDedupKey,
  backorderNoticeText,
  backorderReservedDedupKey,
  backorderUndeliveredDedupKey,
} from './backorder-notice';

const base = {
  backorderId: 'b-1',
  folio: 'BO-000012',
  productName: 'Croquetas Adulto 18 kg',
  variantName: null,
  quantity: 2,
};

const reserved = {
  ...base,
  type: BACKORDER_RESERVED_NOTICE,
  dedupKey: 'backorder-reserved:b-1:3',
};
const undelivered = {
  ...base,
  type: BACKORDER_UNDELIVERED_NOTICE,
  feedType: 'backorder.reserved',
  reason: 'UNREACHABLE',
  dedupKey: 'backorder-undelivered:d-1',
};

describe('backorder staff notices (restock-backorder T2b, contract §9.5, §4)', () => {
  it('has three types, all recognised by the notify consumer', () => {
    expect(BACKORDER_NOTICE_TYPES).toEqual([
      'BACKORDER_RESERVED',
      'BACKORDER_EXPIRED',
      'BACKORDER_NOTICE_UNDELIVERED',
    ]);
    expect(BACKORDER_EXPIRED_NOTICE).toBe('BACKORDER_EXPIRED');
  });

  it('recipients: everyone with read:Backorder', () => {
    expect(BACKORDER_NOTICE_GRANTS).toEqual([['read', 'Backorder']]);
  });

  it('dedup keys: one reserved notice per backorder version, one expiry per backorder, one undelivered per delivery', () => {
    expect(backorderReservedDedupKey('b-1', 3)).toBe(
      'backorder-reserved:b-1:3',
    );
    expect(backorderExpiredDedupKey('b-1')).toBe('backorder-expired:b-1');
    expect(backorderUndeliveredDedupKey('d-1')).toBe(
      'backorder-undelivered:d-1',
    );
  });

  it('recognises its own payloads and leaves request and sale notices alone', () => {
    expect(asBackorderNotice(reserved)).toEqual(reserved);
    expect(asBackorderNotice(undelivered)).toEqual(undelivered);
    expect(
      asBackorderNotice({
        type: 'REQUEST_CREATED',
        requestId: 'r-1',
        folio: 1,
        subtype: 'RESTOCK',
        dedupKey: 'created:r-1',
      }),
    ).toBeNull();
    expect(asBackorderNotice({ type: 'SALE_HOLD_REVIEW' })).toBeNull();
    expect(asBackorderNotice(null)).toBeNull();
  });

  it('a malformed backorder notice is a poison row (throws)', () => {
    expect(() => asBackorderNotice({ ...reserved, backorderId: 1 })).toThrow(
      'malformed backorder notice payload',
    );
    expect(() => asBackorderNotice({ ...reserved, quantity: '2' })).toThrow();
    expect(() =>
      asBackorderNotice({ ...reserved, dedupKey: undefined }),
    ).toThrow();
    expect(() =>
      asBackorderNotice({ ...undelivered, feedType: 'request.answered' }),
    ).toThrow();
    expect(() => asBackorderNotice({ ...undelivered, reason: 7 })).toThrow();
  });

  it('text: reserved, expired and the undelivered call-the-customer notice', () => {
    expect(
      backorderNoticeText(BACKORDER_RESERVED_NOTICE, reserved as never),
    ).toEqual({
      title: 'Pedido por reposición apartado',
      body: 'Pedido BO-000012 · 2 × Croquetas Adulto 18 kg',
    });
    expect(
      backorderNoticeText(BACKORDER_EXPIRED_NOTICE, {
        ...base,
        variantName: 'Rojo',
      }),
    ).toEqual({
      title: 'Apartado de pedido por reposición vencido',
      body: 'Pedido BO-000012 · 2 × Croquetas Adulto 18 kg (Rojo)',
    });
    expect(
      backorderNoticeText(BACKORDER_UNDELIVERED_NOTICE, undelivered as never),
    ).toEqual({
      title: 'No se pudo avisar al cliente de su pedido por reposición',
      body: 'Pedido BO-000012 · 2 × Croquetas Adulto 18 kg · Llámale para que confirme antes de que venza el apartado',
    });
  });

  it('text of an odd payload does not fail', () => {
    expect(backorderNoticeText(BACKORDER_RESERVED_NOTICE, {})).toEqual({
      title: 'Pedido por reposición apartado',
      body: '',
    });
  });
});
