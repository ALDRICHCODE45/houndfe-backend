import {
  BACKORDER_FOLIO_PATTERN,
  formatBackorderFolio,
} from './backorder-folio';

describe('backorder folio', () => {
  it('formats BO-000001 with six digits', () => {
    expect(formatBackorderFolio(1)).toBe('BO-000001');
    expect(formatBackorderFolio(12)).toBe('BO-000012');
    expect(formatBackorderFolio(123456)).toBe('BO-123456');
  });

  it('does not truncate wider numbers', () => {
    expect(formatBackorderFolio(1_234_567)).toBe('BO-1234567');
    expect(BACKORDER_FOLIO_PATTERN.test(formatBackorderFolio(1_234_567))).toBe(
      true,
    );
  });

  it('matches the pattern the database CHECK enforces', () => {
    expect(BACKORDER_FOLIO_PATTERN.test('BO-000001')).toBe(true);
    expect(BACKORDER_FOLIO_PATTERN.test('BO-1')).toBe(false);
    expect(BACKORDER_FOLIO_PATTERN.test('CC-000001')).toBe(false);
    expect(BACKORDER_FOLIO_PATTERN.test('BO-00000a')).toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects the sequence %p', (sequence) => {
    expect(() => formatBackorderFolio(sequence)).toThrow(RangeError);
  });
});
