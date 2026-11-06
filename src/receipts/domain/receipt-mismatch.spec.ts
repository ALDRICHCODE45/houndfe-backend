import { computeReceiptMismatch } from './receipt-mismatch';

describe('computeReceiptMismatch', () => {
  it('records only the debt when nothing was declared or extracted', () => {
    expect(
      computeReceiptMismatch({
        debtCents: 5000,
        declared: null,
        extracted: null,
      }),
    ).toEqual({ debtCents: 5000, flagged: false });
  });

  it('records zero diffs when both amounts match the debt', () => {
    expect(
      computeReceiptMismatch({
        debtCents: 5000,
        declared: 5000,
        extracted: 5000,
      }),
    ).toEqual({
      debtCents: 5000,
      declaredDiffCents: 0,
      extractedDiffCents: 0,
      flagged: false,
    });
  });

  it('flags partial and over payments with signed diffs (amount - debt)', () => {
    expect(
      computeReceiptMismatch({
        debtCents: 5000,
        declared: 3000,
        extracted: 6000,
      }),
    ).toEqual({
      debtCents: 5000,
      declaredDiffCents: -2000,
      extractedDiffCents: 1000,
      flagged: true,
    });
  });

  it('flags disagreement between declared and extracted even if one matches', () => {
    expect(
      computeReceiptMismatch({
        debtCents: 5000,
        declared: 5000,
        extracted: null,
      }).flagged,
    ).toBe(false);
    expect(
      computeReceiptMismatch({
        debtCents: 5000,
        declared: null,
        extracted: 4999,
      }),
    ).toEqual({ debtCents: 5000, extractedDiffCents: -1, flagged: true });
  });
});
