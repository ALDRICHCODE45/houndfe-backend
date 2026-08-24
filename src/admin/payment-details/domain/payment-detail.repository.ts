/**
 * PORT: IPaymentDetailRepository (Driven Port) — Q1 / WU1.
 *
 * Persistence contract the domain demands for `PaymentDetail`. The concrete
 * adapter lives in `infrastructure/prisma-payment-detail.repository.ts` and
 * is wired into the NestJS DI container via the `PAYMENT_DETAIL_REPOSITORY`
 * symbol (mirrors `ROLE_REPOSITORY` / `QUOTATION_REPOSITORY` precedent).
 *
 * TENANT SCOPING: every method takes `tenantId` explicitly. Cross-tenant
 * access returns `null` / empty arrays. The HTTP layer translates to 404.
 */
import type { PaymentDetail } from './payment-detail.entity';

export interface IPaymentDetailRepository {
  /**
   * Persist a new `PaymentDetail` (insert). The adapter MUST honor the
   * `@@unique([tenantId, clabe])` constraint and translate P2002 into
   * a domain `DUPLICATE_CLABE` `BusinessRuleViolationError` (D7).
   */
  create(paymentDetail: PaymentDetail): Promise<PaymentDetail>;

  /** Update an existing `PaymentDetail` by id (within the same tenant).
   *  Returns the reloaded entity after persistence. Throws
   *  `EntityNotFoundError('PaymentDetail', id)` when no row matches. */
  update(paymentDetail: PaymentDetail): Promise<PaymentDetail>;

  /** Find by id within the tenant scope. `null` on miss — including the
   *  cross-tenant case (a row with this id exists but belongs to another
   *  tenant). */
  findById(id: string, tenantId: string): Promise<PaymentDetail | null>;

  /** List every `PaymentDetail` for the tenant (active + inactive), ordered
   *  by `updatedAt DESC` so admins can audit history. */
  findAll(tenantId: string): Promise<PaymentDetail[]>;

  /**
   * Resolve the single "active" account for the tenant — D2 active
   * selection rule: most-recently-updated active row. Returns `null` when
   * the tenant has zero active rows (the bot endpoint translates this to
   * `NO_ACTIVE_PAYMENT_DETAIL`).
   */
  findActive(tenantId: string): Promise<PaymentDetail | null>;
}

/** Injection token — used by NestJS DI to resolve the interface. */
export const PAYMENT_DETAIL_REPOSITORY = Symbol('PAYMENT_DETAIL_REPOSITORY');
