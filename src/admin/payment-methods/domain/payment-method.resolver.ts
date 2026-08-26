/**
 * RESOLVER PORT: IPaymentMethodResolver (Driven Port) — custom-payment-methods / WU2 / D3.
 *
 * The narrow read port the sales service consumes to resolve a
 * `paymentMethodId` (from a charge / add-payment entry) into a
 * `ResolvedPaymentMethod` snapshot. Distinct from `IPaymentMethodRepository`:
 *
 *   - READ-ONLY (no `create` / `update` mutators surface to sales).
 *   - USE-CASE-SHAPED (sales never sees the persistence entity — only
 *     `{ category, name, subtitle }` plus the active-only projection
 *     `{ id, name, category, subtitle }`).
 *   - THROWS DOMAIN CODES (PAYMENT_METHOD_NOT_FOUND / INACTIVE_PAYMENT_METHOD
 *     / PAYMENT_METHOD_CATEGORY_MISMATCH) instead of returning null,
 *     keeping sales-service code free of cross-cutting null-handling.
 *
 * Mirrors the `PromotionsModule` → `SalesModule` Symbol-port seam
 * (`POS_EVALUATE_PROMOTIONS_USE_CASE`): SalesModule imports
 * AdminPaymentMethodModule to resolve the `PAYMENT_METHOD_RESOLVER`
 * symbol, but the sales service depends ONLY on this I/O contract.
 *
 * TENANT SCOPING: the concrete implementation calls
 * `IPaymentMethodRepository.findById(id, tenantId)` / `findAllActive(tenantId)`
 * with an EXPLICIT `tenantId` argument; the adapter underneath enforces
 * `where: { id, tenantId }`. Tenant scoping is NEVER bypassed.
 */
import type { PaymentMethodCategory } from './payment-method.entity';

/** Re-export the 4-value category union so the sales layer does not need
 *  to import from `payment-method.entity.ts` directly. */
export type { PaymentMethodCategory };

/** Result of resolving a single `paymentMethodId` for a charge / add-payment. */
export interface ResolvedPaymentMethod {
  category: PaymentMethodCategory;
  name: string;
  subtitle: string | null;
}

/** Narrow projection for the POS read endpoint (D4). Inactive rows omitted;
 *  `metadataJson` is intentionally NOT included (admin-only field). */
export interface ActivePaymentMethodProjection {
  id: string;
  name: string;
  category: PaymentMethodCategory;
  subtitle: string | null;
}

export interface ResolveActiveInput {
  paymentMethodId: string;
  tenantId: string;
  expectedCategory: PaymentMethodCategory;
}

export interface IPaymentMethodResolver {
  /**
   * Resolve an active, tenant-scoped row for a charge / add-payment
   * entry. Throws:
   *   - `BusinessRuleViolationError('PAYMENT_METHOD_NOT_FOUND')` when
   *     the row does not exist OR belongs to a different tenant (the
   *     cross-tenant case surfaces as 404, never 403 — "never 403" rule).
   *   - `BusinessRuleViolationError('INACTIVE_PAYMENT_METHOD')` when
   *     `isActive === false`.
   *   - `BusinessRuleViolationError('PAYMENT_METHOD_CATEGORY_MISMATCH')`
   *     when `expectedCategory.toLowerCase()` differs from the row's
   *     stored category (case-insensitive compare; the entity already
   *     coerces the stored value to lowercase so the comparison is
   *     symmetric).
   *
   * On success returns the base category + display name + subtitle.
   */
  resolveActive(input: ResolveActiveInput): Promise<ResolvedPaymentMethod>;

  /** Active rows for the POS selector projection (D4). */
  listActive(tenantId: string): Promise<ActivePaymentMethodProjection[]>;
}

/** Injection token — exported alongside the port so `SalesModule` can
 *  `@Inject(PAYMENT_METHOD_RESOLVER) paymentMethodResolver: IPaymentMethodResolver`
 *  without depending on the concrete class. */
export const PAYMENT_METHOD_RESOLVER = Symbol('PAYMENT_METHOD_RESOLVER');