/**
 * VALUE OBJECT: IvaRate
 *
 * Represents the IVA tax rate with explicit EXENTO semantics.
 * IVA_0 and IVA_EXENTO are distinct: 0% IVA is taxable at 0%, EXENTO is exempt.
 */
import { InvalidArgumentError } from '../../../shared/domain/domain-error';

export const IVA_RATES = ['IVA_16', 'IVA_8', 'IVA_0', 'IVA_EXENTO'] as const;
export type IvaRateValue = (typeof IVA_RATES)[number];

const IVA_PERCENTAGES: Record<IvaRateValue, number> = {
  IVA_16: 16,
  IVA_8: 8,
  IVA_0: 0,
  IVA_EXENTO: 0,
};

export class IvaRate {
  private constructor(public readonly value: IvaRateValue) {}

  static create(value: string): IvaRate {
    if (!IVA_RATES.includes(value as IvaRateValue)) {
      throw new InvalidArgumentError(
        `Invalid IVA rate: ${value}. Allowed: ${IVA_RATES.join(', ')}`,
      );
    }
    return new IvaRate(value as IvaRateValue);
  }

  static fromPersistence(value: string): IvaRate {
    return new IvaRate(value as IvaRateValue);
  }

  get percentage(): number {
    return IVA_PERCENTAGES[this.value];
  }

  get isExempt(): boolean {
    return this.value === 'IVA_EXENTO';
  }

  /** Returns the multiplier (e.g., 0.16 for 16%) */
  get multiplier(): number {
    return this.percentage / 100;
  }

  equals(other: IvaRate): boolean {
    return this.value === other.value;
  }
}
