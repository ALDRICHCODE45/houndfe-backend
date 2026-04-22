import { InvalidArgumentError } from '../../shared/domain/domain-error';

export interface SaleItemProps {
  id: string;
  saleId: string;
  productId: string;
  variantId: string | null;
  productName: string;
  variantName: string | null;
  quantity: number;
  unitPriceCents: number;
  unitPriceCurrency: string;
}

/**
 * SaleItem Entity - represents a line item in a POS sale
 *
 * Business rules:
 * - Quantity must be >= 1
 * - Unit price must be >= 0
 * - Price is frozen at add-time (snapshot from product/variant)
 * - Items are identified by product+variant combination for stacking
 */
export class SaleItem {
  private constructor(
    public readonly id: string,
    public readonly saleId: string,
    public readonly productId: string,
    public readonly variantId: string | null,
    public readonly productName: string,
    public readonly variantName: string | null,
    private _quantity: number,
    public readonly unitPriceCents: number,
    public readonly unitPriceCurrency: string,
  ) {}

  static create(props: SaleItemProps): SaleItem {
    // Validate required fields
    if (!props.productId || props.productId.trim() === '') {
      throw new InvalidArgumentError('Product ID cannot be empty');
    }
    if (!props.productName || props.productName.trim() === '') {
      throw new InvalidArgumentError('Product name cannot be empty');
    }

    // Validate quantity
    if (props.quantity < 1) {
      throw new InvalidArgumentError('Quantity must be at least 1');
    }

    // Validate price
    if (props.unitPriceCents < 0) {
      throw new InvalidArgumentError('Unit price cannot be negative');
    }

    return new SaleItem(
      props.id,
      props.saleId,
      props.productId,
      props.variantId,
      props.productName,
      props.variantName,
      props.quantity,
      props.unitPriceCents,
      props.unitPriceCurrency,
    );
  }

  static fromPersistence(props: SaleItemProps): SaleItem {
    return new SaleItem(
      props.id,
      props.saleId,
      props.productId,
      props.variantId,
      props.productName,
      props.variantName,
      props.quantity,
      props.unitPriceCents,
      props.unitPriceCurrency,
    );
  }

  get quantity(): number {
    return this._quantity;
  }

  changeQuantity(newQuantity: number): void {
    if (newQuantity < 1) {
      throw new InvalidArgumentError('Quantity must be at least 1');
    }
    this._quantity = newQuantity;
  }

  matches(productId: string, variantId: string | null): boolean {
    return this.productId === productId && this.variantId === variantId;
  }

  toResponse() {
    return {
      id: this.id,
      productId: this.productId,
      variantId: this.variantId,
      productName: this.productName,
      variantName: this.variantName,
      quantity: this.quantity,
      unitPriceCents: this.unitPriceCents,
      unitPriceCurrency: this.unitPriceCurrency,
    };
  }
}
