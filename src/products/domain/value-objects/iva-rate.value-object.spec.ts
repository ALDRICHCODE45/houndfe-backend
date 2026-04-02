import { IvaRate } from './iva-rate.value-object';
import { InvalidArgumentError } from '../../../shared/domain/domain-error';

describe('IvaRate Value Object', () => {
  it('should create IVA_16', () => {
    const rate = IvaRate.create('IVA_16');
    expect(rate.value).toBe('IVA_16');
    expect(rate.percentage).toBe(16);
    expect(rate.multiplier).toBe(0.16);
    expect(rate.isExempt).toBe(false);
  });

  it('should create IVA_0', () => {
    const rate = IvaRate.create('IVA_0');
    expect(rate.percentage).toBe(0);
    expect(rate.isExempt).toBe(false);
  });

  it('should create IVA_EXENTO', () => {
    const rate = IvaRate.create('IVA_EXENTO');
    expect(rate.percentage).toBe(0);
    expect(rate.isExempt).toBe(true);
  });

  it('IVA_0 and IVA_EXENTO should NOT be equal', () => {
    const zero = IvaRate.create('IVA_0');
    const exempt = IvaRate.create('IVA_EXENTO');
    expect(zero.equals(exempt)).toBe(false);
  });

  it('should throw on invalid value', () => {
    expect(() => IvaRate.create('IVA_100')).toThrow(InvalidArgumentError);
  });
});
