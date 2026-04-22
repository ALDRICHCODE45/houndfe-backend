import { Sale } from './sale.entity';

/**
 * Sale Repository Port - defines persistence operations for Sales
 *
 * This is a port (interface) in hexagonal architecture.
 * Concrete implementation (adapter) will be in infrastructure layer.
 */
export interface ISaleRepository {
  /**
   * Save a sale (create or update)
   */
  save(sale: Sale): Promise<Sale>;

  /**
   * Find sale by ID
   */
  findById(id: string): Promise<Sale | null>;

  /**
   * Find all DRAFT sales owned by a user
   */
  findDraftsByUserId(userId: string): Promise<Sale[]>;

  /**
   * Delete a sale by ID
   */
  delete(id: string): Promise<void>;
}

/**
 * Injection token for ISaleRepository
 */
export const SALE_REPOSITORY = Symbol('ISaleRepository');
