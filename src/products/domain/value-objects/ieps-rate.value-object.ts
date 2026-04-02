/**
 * VALUE OBJECT: IepsRate
 *
 * Represents the IEPS tax rate. NO_APLICA means product is not subject to IEPS.
 */
import { InvalidArgumentError } from '../../../shared/domain/domain-error';

export const IEPS_RATES = [
  'NO_APLICA',
  'IEPS_160',
  'IEPS_53',
  'IEPS_50',
  'IEPS_30_4',
  'IEPS_30',
  'IEPS_26_5',
  'IEPS_25',
  'IEPS_9',
  'IEPS_8',
  'IEPS_7',
  'IEPS_6',
  'IEPS_3',
  'IEPS_0',
] as const;

export type IepsRateValue = (typeof IEPS_RATES)[number];

const IEPS_PERCENTAGES: Record<IepsRateValue, number> = {
  NO_APLICA: 0,
  IEPS_160: 160,
  IEPS_53: 53,
  IEPS_50: 50,
  IEPS_30_4: 30.4,
  IEPS_30: 30,
  IEPS_26_5: 26.5,
  IEPS_25: 25,
  IEPS_9: 9,
  IEPS_8: 8,
  IEPS_7: 7,
  IEPS_6: 6,
  IEPS_3: 3,
  IEPS_0: 0,
};

export class IepsRate {
  private constructor(public readonly value: IepsRateValue) {}

  static create(value: string): IepsRate {
    if (!IEPS_RATES.includes(value as IepsRateValue)) {
      throw new InvalidArgumentError(
        `Invalid IEPS rate: ${value}. Allowed: ${IEPS_RATES.join(', ')}`,
      );
    }
    return new IepsRate(value as IepsRateValue);
  }

  static fromPersistence(value: string): IepsRate {
    return new IepsRate(value as IepsRateValue);
  }

  get percentage(): number {
    return IEPS_PERCENTAGES[this.value];
  }

  get multiplier(): number {
    return this.percentage / 100;
  }

  get applies(): boolean {
    return this.value !== 'NO_APLICA';
  }

  equals(other: IepsRate): boolean {
    return this.value === other.value;
  }
}
