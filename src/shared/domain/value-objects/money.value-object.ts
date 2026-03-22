/**
 * VALUE OBJECT: Money
 *
 * Immutable representation of monetary values.
 * Stores amounts in cents (integer) to avoid floating-point precision issues.
 *
 * @example
 *   const price = Money.fromDecimal(10.50, 'USD');
 *   const doubled = price.multiply(2); // $21.00
 *   price.amount // still 10.50 (immutable)
 */

export type Currency = 'USD' | 'EUR' | 'ARS' | 'MXN';

export class Money {
  private readonly cents: number;
  private readonly _currency: Currency;

  private constructor(cents: number, currency: Currency) {
    this.cents = cents;
    this._currency = currency;
  }

  static fromDecimal(amount: number, currency: Currency): Money {
    if (amount < 0) throw new Error('Amount cannot be negative');
    return new Money(Math.round(amount * 100), currency);
  }

  static fromCents(cents: number, currency: Currency): Money {
    if (cents < 0) throw new Error('Cents cannot be negative');
    return new Money(Math.round(cents), currency);
  }

  static zero(currency: Currency): Money {
    return new Money(0, currency);
  }

  get amount(): number {
    return this.cents / 100;
  }

  get currency(): Currency {
    return this._currency;
  }

  add(other: Money): Money {
    this.ensureSameCurrency(other);
    return new Money(this.cents + other.cents, this._currency);
  }

  subtract(other: Money): Money {
    this.ensureSameCurrency(other);
    if (this.cents - other.cents < 0)
      throw new Error('Result would be negative');
    return new Money(this.cents - other.cents, this._currency);
  }

  multiply(factor: number): Money {
    return new Money(Math.round(this.cents * factor), this._currency);
  }

  isGreaterThan(other: Money): boolean {
    this.ensureSameCurrency(other);
    return this.cents > other.cents;
  }

  isLessThan(other: Money): boolean {
    this.ensureSameCurrency(other);
    return this.cents < other.cents;
  }
  isZero(): boolean {
    return this.cents === 0;
  }

  equals(other: Money): boolean {
    return this.cents === other.cents && this._currency === other._currency;
  }

  format(): string {
    const symbols: Record<Currency, string> = {
      USD: '$',
      EUR: '€',
      ARS: '$',
      MXN: '$',
    };
    return `${symbols[this._currency]}${this.amount.toFixed(2)}`;
  }

  toJSON(): { amount: number; currency: Currency } {
    return { amount: this.amount, currency: this._currency };
  }

  private ensureSameCurrency(other: Money): void {
    if (this._currency !== other._currency) {
      throw new Error(
        `Cannot operate: ${this._currency} vs ${other._currency}`,
      );
    }
  }
}
