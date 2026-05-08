/**
 * PORT: IProductRepository (Driven Port)
 *
 * Contract that the domain DEMANDS for persistence.
 * Lives in domain, implemented in infrastructure.
 */
import { Product } from './product.entity';

export interface IProductRepository {
  findById(id: string): Promise<Product | null>;
  findBySku(sku: string): Promise<Product | null>;
  findByBarcode(barcode: string): Promise<Product | null>;
  findAll(): Promise<Product[]>;
  save(product: Product): Promise<Product>;
  delete(id: string): Promise<void>;

  /** Check SKU uniqueness across products and variants */
  isSkuTaken(
    sku: string,
    exclude?: { productId?: string; variantId?: string },
  ): Promise<boolean>;

  /** Check barcode uniqueness across products and variants */
  isBarcodeTaken(
    barcode: string,
    exclude?: { productId?: string; variantId?: string },
  ): Promise<boolean>;

  /**
   * Charge-time stock decrement contract (implemented in PR2).
   */
  decrementStockForCharge(
    adjustments: Array<{
      productId: string;
      variantId?: string | null;
      quantity: number;
    }>,
  ): Promise<void>;
}

/** Injection token — used by NestJS DI to resolve the interface. */
export const PRODUCT_REPOSITORY = Symbol('PRODUCT_REPOSITORY');
