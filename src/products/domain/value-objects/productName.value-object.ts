/**
 * VALUE OBJECT: ProductName
 *
 * Immutable representation of ProductName values.
 * Stores product names in string to avoid business logic issues
 *
 * @example
 *   const price = new ProductName('ProductName')
 *   const doubled = price.isValie(); // true -> false
 */

import { BusinessRuleViolationError, InvalidArgumentError } from 'src/shared';

export class ProductName {
  private readonly name: string;

  private constructor(name: string) {
    this.name = name;
  }

  public static create(name: string) {
    if (!name.trim()) {
      throw new InvalidArgumentError('Product name is required');
    }

    if (name.length <= 3) {
      throw new BusinessRuleViolationError(
        'Product Name must have at least 4 characteres',
        'INVALID_PRODUC_NAME',
      );
    }

    if (name.length >= 31) {
      throw new BusinessRuleViolationError(
        'Product Name must have maximum 30 characteres',
        'INVALID_PRODUC_NAME',
      );
    }

    const cleanName = name.trim().replace(/\s+/g, ' ');

    if (/^\d+$/.test(cleanName)) {
      throw new BusinessRuleViolationError(
        'Product Name cannot have only numbers',
        'INVALID_PRODUC_NAME',
      );
    }
    return new ProductName(cleanName);
  }

  get productName(): string {
    return this.name;
  }

  static fromPersistence(data: { name: string }) {
    return new ProductName(data.name);
  }
}
