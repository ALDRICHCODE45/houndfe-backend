/**
 * VALUE OBJECT: PurchaseCost
 *
 * Stores purchase cost in both net and gross cents.
 * Derives one from the other based on mode + taxes.
 *
 * Net = cost before taxes
 * Gross = cost after taxes (net + IVA + IEPS)
 */
import { InvalidArgumentError } from '../../../shared/domain/domain-error';

export type PurchaseCostModeValue = 'NET' | 'GROSS';

export class PurchaseCost {
  private constructor(
    public readonly mode: PurchaseCostModeValue,
    public readonly netCents: number,
    public readonly grossCents: number,
  ) {}

  /**
   * Creates a PurchaseCost, deriving the other value from taxes.
   * @param mode - Whether the input value is NET or GROSS
   * @param valueCents - The input value in cents
   * @param ivaMultiplier - e.g. 0.16 for 16%
   * @param iepsMultiplier - e.g. 0.08 for 8%
   */
  static create(
    mode: PurchaseCostModeValue,
    valueCents: number,
    ivaMultiplier: number,
    iepsMultiplier: number,
  ): PurchaseCost {
    if (valueCents < 0) {
      throw new InvalidArgumentError('Purchase cost cannot be negative');
    }

    const totalTaxMultiplier = 1 + ivaMultiplier + iepsMultiplier;

    if (mode === 'NET') {
      const netCents = Math.round(valueCents);
      const grossCents = Math.round(netCents * totalTaxMultiplier);
      return new PurchaseCost('NET', netCents, grossCents);
    } else {
      const grossCents = Math.round(valueCents);
      const netCents = Math.round(grossCents / totalTaxMultiplier);
      return new PurchaseCost('GROSS', netCents, grossCents);
    }
  }

  static fromPersistence(
    mode: PurchaseCostModeValue,
    netCents: number,
    grossCents: number,
  ): PurchaseCost {
    return new PurchaseCost(mode, netCents, grossCents);
  }

  get netDecimal(): number {
    return this.netCents / 100;
  }

  get grossDecimal(): number {
    return this.grossCents / 100;
  }

  equals(other: PurchaseCost): boolean {
    return (
      this.mode === other.mode &&
      this.netCents === other.netCents &&
      this.grossCents === other.grossCents
    );
  }
}
