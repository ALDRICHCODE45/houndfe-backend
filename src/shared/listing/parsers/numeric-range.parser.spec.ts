import { parseNumericRange } from './numeric-range.parser';

describe('parseNumericRange', () => {
  it('parses only min boundary', () => {
    expect(
      parseNumericRange({
        field: 'total',
        minField: 'totalMin',
        maxField: 'totalMax',
        min: 5000,
      }),
    ).toEqual({ min: 5000, max: undefined });
  });

  it('accepts zero boundaries', () => {
    expect(
      parseNumericRange({
        field: 'debt',
        minField: 'debtMin',
        maxField: 'debtMax',
        min: 0,
        max: 0,
      }),
    ).toEqual({ min: 0, max: 0 });
  });

  it('throws LISTING_INVERTED_RANGE when min is greater than max', () => {
    expect(() =>
      parseNumericRange({
        field: 'total',
        minField: 'totalMin',
        maxField: 'totalMax',
        min: 200,
        max: 100,
      }),
    ).toThrow('LISTING_INVERTED_RANGE');
  });

  it('throws LISTING_INVALID_NUMBER for non-finite values', () => {
    expect(() =>
      parseNumericRange({
        field: 'total',
        minField: 'totalMin',
        maxField: 'totalMax',
        min: Number.NaN,
      }),
    ).toThrow('LISTING_INVALID_NUMBER');
  });
});
