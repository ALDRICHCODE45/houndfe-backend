/**
 * PORT: IPaymentMethodRepository (Driven Port) — custom-payment-methods / WU1.
 *
 * Persistence contract the domain demands for `PaymentMethod`. The concrete
 * adapter lives in `infrastructure/prisma-payment-method.repository.ts` and
 * is wired into the NestJS DI container via the `PAYMENT_METHOD_REPOSITORY`
 * symbol (mirrors the `PAYMENT_DETAIL_REPOSITORY` precedent).
 *
 * TENANT SCOPING: every method takes `tenantId` explicitly. Cross-tenant
 * access returns `null` / empty arrays. The HTTP layer translates to 404.
 */
import type { PaymentMethod } from './payment-method.entity';

export interface IPaymentMethodRepository {
  /** Persist a new `PaymentMethod` (insert). The adapter MUST honor the
   *  `@@unique([tenantId, name])` constraint and translate Prisma P2002
   *  into a domain `DUPLICATE_NAME` `BusinessRuleViolationError` (D9). */
  create(paymentMethod: PaymentMethod): Promise<PaymentMethod>;

  /** Update an existing `PaymentMethod` by id (within the same tenant).
   *  Returns the reloaded entity after persistence. Throws
   *  `EntityNotFoundError('PaymentMethod', id)` when no row matches. */
  update(paymentMethod: PaymentMethod): Promise<PaymentMethod>;

  /** Find by id within the tenant scope. `null` on miss — including the
   *  cross-tenant case (a row with this id exists but belongs to another
   *  tenant). Defense-in-depth: explicit `where: { id, tenantId }` is
   *  passed by the adapter even when the tenant-scoped extension is
   *  active (D1). */
  findById(id: string, tenantId: string): Promise<PaymentMethod | null>;

  /** List every `PaymentMethod` for the tenant (active + inactive), ordered
   *  by `updatedAt DESC` so admins can audit history. */
  findAll(tenantId: string): Promise<PaymentMethod[]>;

  /** Active rows only (`isActive=true`), ordered by `updatedAt DESC` —
   *  used by the POS read projection (D4) for the selector dropdown.
   *  Backend ordering kept simple; the POS sorts by `name` client-side. */
  findAllActive(tenantId: string): Promise<PaymentMethod[]>;
}

/** Injection token — used by NestJS DI to resolve the interface. */
export const PAYMENT_METHOD_REPOSITORY = Symbol('PAYMENT_METHOD_REPOSITORY');