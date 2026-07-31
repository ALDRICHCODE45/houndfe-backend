import { Quotation } from './quotation.entity';
import type { QuotationStatus } from './quotation.entity';

/**
 * WU2 — Service-layer input contracts. Kept on the repository port so
 * the service module doesn't grow a parallel "dto.types" barrel; the
 * adapter-side implementation can drop unknown fields without coupling
 * to its concrete consumer. Pure data carriers — validation lives in
 * the controller's DTO class.
 */
export interface CreateQuotationInput {
  customerId?: string;
  globalPriceListId?: string | null;
}

export interface AssignCustomerInput {
  customerId: string;
}

export interface SetPriceListInput {
  globalPriceListId?: string | null;
}

/**
 * FindAll input from the service layer. The DTO layer applies defaults
 * before this is constructed (page=1, limit=20, sort defaults), so the
 * service can rely on the values being present after the controller
 * pipes the query through `ValidationPipe`.
 */
export interface QuotationFindAllInput {
  page: number;
  limit: number;
  status?: QuotationStatus;
  customerId?: string;
  createdFrom?: Date;
  createdTo?: Date;
  sortBy?: 'createdAt' | 'updatedAt' | 'totalCents' | 'expiresAt';
  sortOrder?: 'asc' | 'desc';
}

export interface QuotationListPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface QuotationListResult {
  data: import('../dto/quotation-response.dto').QuotationResponseDto[];
  pagination: QuotationListPagination;
}

/**
 * Pagination + filter query for the quotation list endpoint. Mirrors the
 * PromotionFindAllQuery shape but with quotation-specific filters.
 *
 * `status` is the persisted status. For lazy EXPIRED filtering, the
 * caller resolves `getEffectiveStatus(now)` on each row after the read —
 * the DB query stays simple (status IN [...]) and the EXPIRED transition
 * happens in the service layer.
 */
export interface QuotationFindAllQuery {
  page: number;
  limit: number;
  status?: QuotationStatus;
  customerId?: string;
  /** Date-range filter on `createdAt`. */
  createdFrom?: Date;
  createdTo?: Date;
  sortBy?: 'createdAt' | 'updatedAt' | 'totalCents' | 'expiresAt';
  sortOrder?: 'asc' | 'desc';
}

export interface QuotationFindAllResult {
  data: Quotation[];
  total: number;
}

/**
 * Quotation Repository Port — persistence operations for quotations.
 *
 * This is the port (interface) in hexagonal architecture. The concrete
 * Prisma adapter lives in `infrastructure/prisma-quotation.repository.ts`.
 * All methods are tenant-scoped via `TenantPrismaService`; cross-tenant
 * reads return `null` / empty arrays (HTTP layer translates to 404).
 */
export interface IQuotationRepository {
  /**
   * Persist a quotation (insert if absent, update if present). Recreates
   * items, veto, and opt-in junction rows on every call so the in-memory
   * aggregate is the single source of truth.
   */
  save(quotation: Quotation): Promise<Quotation>;

  /** Find a quotation by id within the current tenant scope. */
  findById(id: string): Promise<Quotation | null>;

  /**
   * Find quotations matching the query, scoped to the current tenant.
   * Returns paginated `{ data, total }`.
   */
  findAll(query: QuotationFindAllQuery): Promise<QuotationFindAllResult>;

  /**
   * Hard-delete the quotation by id within the current tenant scope.
   * Cascades to items + promotion junction tables. Idempotent: a missing
   * id does NOT throw (returns void).
   */
  delete(id: string): Promise<void>;
}

/**
 * Injection token for `IQuotationRepository`. Mirrors the
 * `SALE_REPOSITORY` / `PROMOTION_REPOSITORY` token convention so the DI
 * wiring in WU2's `QuotationsModule` can use the same `useClass` pattern.
 */
export const QUOTATION_REPOSITORY = Symbol('IQuotationRepository');
