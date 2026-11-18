import {
  asSaleHoldReviewNotice,
  saleHoldReviewDedupKey,
  saleHoldReviewText,
} from './sale-hold-notice';

const notice = {
  type: 'SALE_HOLD_REVIEW',
  saleId: 's-1',
  saleFolio: 'V-000042',
  holdVersion: 3,
  reason: 'PAYMENT_RECEIVED',
  dedupKey: 'hold-review:s-1:3',
};

describe('sale hold review notice (pay-in-store-pickup / T2, S4)', () => {
  it('one notice per sale and hold version', () => {
    expect(saleHoldReviewDedupKey('s-1', 3)).toBe('hold-review:s-1:3');
  });

  it('recognises its own payload and leaves request notices alone', () => {
    expect(asSaleHoldReviewNotice(notice)).toEqual(notice);
    expect(
      asSaleHoldReviewNotice({ ...notice, saleFolio: null }),
    ).toMatchObject({ saleFolio: null });
    expect(
      asSaleHoldReviewNotice({
        type: 'REQUEST_CREATED',
        requestId: 'r-1',
        folio: 1,
        subtype: 'RESTOCK',
        dedupKey: 'created:r-1',
      }),
    ).toBeNull();
    expect(asSaleHoldReviewNotice(null)).toBeNull();
  });

  it('a malformed sale notice is a poison row (throws)', () => {
    expect(() =>
      asSaleHoldReviewNotice({ ...notice, reason: 'OTHER' }),
    ).toThrow('malformed sale hold review notice payload');
    expect(() => asSaleHoldReviewNotice({ ...notice, saleId: 1 })).toThrow();
  });

  it('text per reason', () => {
    expect(saleHoldReviewText(notice as never)).toEqual({
      title: 'Apartado vencido: revisa la venta',
      body: 'Venta V-000042 · Tiene un pago registrado',
    });
    expect(
      saleHoldReviewText({ saleFolio: 'V-1', reason: 'RECEIPT_PENDING' }),
    ).toEqual({
      title: 'Apartado vencido: revisa la venta',
      body: 'Venta V-1 · Comprobante pendiente de revisar',
    });
  });
});
