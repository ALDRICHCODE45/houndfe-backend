/**
 * VALUE OBJECT: ProductName
 *
 * Immutable representation of a product name.
 * Business rules:
 * - Required, non-empty
 * - Between 1 and 100 characters (relaxed from original 4-30 limit)
 * - Cannot be only numbers
 */
import {
  BusinessRuleViolationError,
  InvalidArgumentError,
} from '../../../shared/domain/domain-error';

export class ProductName {
  private readonly name: string;

  private constructor(name: string) {
    this.name = name;
  }

  public static create(name: string): ProductName {
    if (!name?.trim()) {
      throw new InvalidArgumentError('Product name is required');
    }

    const cleanName = name.trim().replace(/\s+/g, ' ');

    if (cleanName.length > 100) {
      throw new BusinessRuleViolationError(
        'Product name must have maximum 100 characters',
        'INVALID_PRODUCT_NAME',
      );
    }

    if (/^\d+$/.test(cleanName)) {
      throw new BusinessRuleViolationError(
        'Product name cannot have only numbers',
        'INVALID_PRODUCT_NAME',
      );
    }

    return new ProductName(cleanName);
  }

  get productName(): string {
    return this.name;
  }

  static fromPersistence(data: { name: string }): ProductName {
    return new ProductName(data.name);
  }

  equals(other: ProductName): boolean {
    return this.name === other.name;
  }
}
