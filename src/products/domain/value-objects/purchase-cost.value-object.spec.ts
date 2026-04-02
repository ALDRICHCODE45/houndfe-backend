import { PurchaseCost } from './purchase-cost.value-object';
import { InvalidArgumentError } from '../../../shared/domain/domain-error';

describe('PurchaseCost Value Object', () => {
  describe('NET mode', () => {
    it('should derive gross from net + IVA 16%', () => {
      const cost = PurchaseCost.create('NET', 10000, 0.16, 0);
      expect(cost.netCents).toBe(10000);
      expect(cost.grossCents).toBe(11600);
      expect(cost.netDecimal).toBe(100);
      expect(cost.grossDecimal).toBe(116);
    });

    it('should derive gross from net + IVA + IEPS', () => {
      const cost = PurchaseCost.create('NET', 10000, 0.16, 0.08);
      expect(cost.grossCents).toBe(12400); // 10000 * 1.24
    });
  });

  describe('GROSS mode', () => {
    it('should derive net from gross / (1 + taxes)', () => {
      const cost = PurchaseCost.create('GROSS', 11600, 0.16, 0);
      expect(cost.grossCents).toBe(11600);
      expect(cost.netCents).toBe(10000);
    });
  });

  it('should throw on negative value', () => {
    expect(() => PurchaseCost.create('NET', -100, 0.16, 0)).toThrow(
      InvalidArgumentError,
    );
  });

  it('should handle zero cost', () => {
    const cost = PurchaseCost.create('NET', 0, 0.16, 0);
    expect(cost.netCents).toBe(0);
    expect(cost.grossCents).toBe(0);
  });
});
