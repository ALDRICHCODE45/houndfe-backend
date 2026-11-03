import {
  DECIMAL_UNITS,
  isQuantityAllowedForUnit,
  multiplyDecimals,
} from './po-decimal';
import { UNITS_OF_MEASURE } from './po-contract';

describe('exact PO decimals', () => {
  it.each([
    ['0.1', '0.2', '0.02'],
    ['12.500', '2.4000', '30'],
    ['999999999.999', '999999999999.9999', '999999999998999900000.0000001'],
    ['1', '0', '0'],
    ['0.001', '0.0001', '0.0000001'],
    ['2', '3', '6'],
  ])('%s × %s = %s', (a, b, result) => {
    expect(multiplyDecimals(a, b)).toBe(result);
  });
  it('allows fractional notation only on decimal units (including .000)', () => {
    expect([...DECIMAL_UNITS]).toEqual([
      'KILOGRAMO',
      'GRAMO',
      'LITRO',
      'METRO',
      'CENTIMETRO',
    ]);
    for (const unit of UNITS_OF_MEASURE) {
      expect(isQuantityAllowedForUnit('1', unit)).toBe(true);
      expect(isQuantityAllowedForUnit('1.001', unit)).toBe(
        DECIMAL_UNITS.has(unit),
      );
      expect(isQuantityAllowedForUnit('1.000', unit)).toBe(
        DECIMAL_UNITS.has(unit),
      );
      expect(isQuantityAllowedForUnit('0', unit)).toBe(false);
      expect(isQuantityAllowedForUnit('1\n', unit)).toBe(false);
    }
  });
  it.each(['-1', '1e3', '01', '', '.2', '1\n', '1\u2028'])(
    'rejects invalid decimal %s without float coercion',
    (value) => {
      expect(() => multiplyDecimals(value, '1')).toThrow('MALFORMED');
    },
  );
});
