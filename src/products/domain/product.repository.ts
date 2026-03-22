/**
 * PORT: IProductRepository (Driven Port)
 *
 * Contract that the domain DEMANDS for persistence.
 * Lives in domain, implemented in infrastructure.
 *
 * If you switch from Prisma to TypeORM or MongoDB,
 * you only create a new adapter — domain stays untouched.
 */
import { Product } from './product.entity';

export interface IProductRepository {
  findById(id: string): Promise<Product | null>;
  findBySku(sku: string): Promise<Product | null>;
  findAll(): Promise<Product[]>;
  findInStock(): Promise<Product[]>;
  save(product: Product): Promise<Product>;
  delete(id: string): Promise<void>;
}

/** Injection token — used by NestJS DI to resolve the interface. */
export const PRODUCT_REPOSITORY = Symbol('PRODUCT_REPOSITORY');
