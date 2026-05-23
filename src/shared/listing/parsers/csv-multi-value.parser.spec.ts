import { parseCsvMultiValue } from './csv-multi-value.parser';

describe('parseCsvMultiValue', () => {
  it('returns empty array for blank input', () => {
    expect(parseCsvMultiValue('', { field: 'status', cap: 50 })).toEqual([]);
  });

  it('trims values and deduplicates preserving first-seen order', () => {
    expect(parseCsvMultiValue(' A , B , A ', { field: 'status', cap: 50 })).toEqual([
      'A',
      'B',
    ]);
  });

  it('ignores trailing commas and blank entries', () => {
    expect(parseCsvMultiValue('PAID,,PARTIAL,', { field: 'paymentStatus', cap: 50 })).toEqual([
      'PAID',
      'PARTIAL',
    ]);
  });

  it('throws LISTING_TOO_MANY_VALUES when cap is exceeded', () => {
    const values = Array.from({ length: 201 }, (_, index) => `v-${index + 1}`).join(',');

    expect(() => parseCsvMultiValue(values, { field: 'folio', cap: 200 })).toThrow(
      'LISTING_TOO_MANY_VALUES',
    );
  });
});
