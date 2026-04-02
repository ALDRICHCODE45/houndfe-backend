import { IepsRate, IEPS_RATES } from './ieps-rate.value-object';
import { InvalidArgumentError } from '../../../shared/domain/domain-error';

describe('IepsRate Value Object', () => {
  describe('valid set', () => {
    it('should accept all defined IEPS rates', () => {
      for (const rate of IEPS_RATES) {
        expect(() => IepsRate.create(rate)).not.toThrow();
      }
    });

    it('should reject invalid values', () => {
      expect(() => IepsRate.create('IEPS_99')).toThrow(InvalidArgumentError);
      expect(() => IepsRate.create('')).toThrow(InvalidArgumentError);
      expect(() => IepsRate.create('IVA_16')).toThrow(InvalidArgumentError);
    });
  });

  describe('NO_APLICA', () => {
    it('should have 0 percentage and multiplier', () => {
      const rate = IepsRate.create('NO_APLICA');
      expect(rate.percentage).toBe(0);
      expect(rate.multiplier).toBe(0);
      expect(rate.applies).toBe(false);
    });
  });

  describe('multipliers', () => {
    it.each([
      ['IEPS_160', 1.6],
      ['IEPS_53', 0.53],
      ['IEPS_50', 0.5],
      ['IEPS_30_4', 0.304],
      ['IEPS_30', 0.3],
      ['IEPS_26_5', 0.265],
      ['IEPS_25', 0.25],
      ['IEPS_9', 0.09],
      ['IEPS_8', 0.08],
      ['IEPS_7', 0.07],
      ['IEPS_6', 0.06],
      ['IEPS_3', 0.03],
      ['IEPS_0', 0],
    ] as const)(
      '%s should have multiplier %s',
      (value: string, expectedMultiplier: number) => {
        const rate = IepsRate.create(value);
        expect(rate.multiplier).toBeCloseTo(expectedMultiplier, 4);
        // IEPS_0 means 0% rate but IEPS still applies. Only NO_APLICA = not subject.
        expect(rate.applies).toBe(true);
      },
    );
  });

  describe('percentages', () => {
    it.each([
      ['IEPS_160', 160],
      ['IEPS_53', 53],
      ['IEPS_50', 50],
      ['IEPS_30_4', 30.4],
      ['IEPS_30', 30],
      ['IEPS_26_5', 26.5],
      ['IEPS_25', 25],
      ['IEPS_9', 9],
      ['IEPS_8', 8],
      ['IEPS_7', 7],
      ['IEPS_6', 6],
      ['IEPS_3', 3],
      ['IEPS_0', 0],
    ] as const)('%s should have percentage %s', (value, expectedPct) => {
      const rate = IepsRate.create(value);
      expect(rate.percentage).toBe(expectedPct);
    });
  });

  describe('equality', () => {
    it('should be equal for same rate', () => {
      const a = IepsRate.create('IEPS_8');
      const b = IepsRate.create('IEPS_8');
      expect(a.equals(b)).toBe(true);
    });

    it('should not be equal for different rates', () => {
      const a = IepsRate.create('IEPS_8');
      const b = IepsRate.create('IEPS_3');
      expect(a.equals(b)).toBe(false);
    });

    it('IEPS_0 and NO_APLICA should not be equal despite same multiplier', () => {
      const zero = IepsRate.create('IEPS_0');
      const noAplica = IepsRate.create('NO_APLICA');
      expect(zero.multiplier).toBe(noAplica.multiplier); // both 0
      expect(zero.equals(noAplica)).toBe(false); // but semantically distinct
    });
  });

  describe('fromPersistence', () => {
    it('should reconstruct without validation', () => {
      const rate = IepsRate.fromPersistence('IEPS_160');
      expect(rate.value).toBe('IEPS_160');
      expect(rate.multiplier).toBe(1.6);
    });
  });

  describe('applies', () => {
    it('IEPS_0 applies — 0% IEPS is still IEPS', () => {
      // IEPS_0 means 0% tax rate but the tax DOES apply to the product.
      // NO_APLICA means the product is not subject to IEPS at all.
      const rate = IepsRate.create('IEPS_0');
      expect(rate.applies).toBe(true);
    });
  });
});
