/**
 * QuotationsService — Application layer (Use Cases) for the Quotations
 * bounded context.
 *
 * WU2 — Service core + draft CRUD + customer + price-list mutation +
 * lazy EXPIRED on read. The recompute pipeline is wired but is a
 * no-op stub at this layer — WU3 implements the real
 * clear → reprice → eval with the engine's `context='QUOTATION'`
 * branch.
 *
 * The dependency surface stays tight:
 *   - `IQuotationRepository`              — domain port (DI token).
 *   - `TenantPrismaService`               — tenant-scoped Prisma client
 *                                          for catalog lookups
 *                                          (`Customer.globalPriceListId`,
 *                                          `GlobalPriceList` existence).
 *
 * Why no `CustomerService` injection: We only need the customer's
 * `globalPriceListId` for the auto-seed (and the customer's existence
 * for the 404 guard). Reading the catalog row directly through
 * `TenantPrismaService.getClient()` keeps the dependency graph minimal
 * and avoids forcing a `CustomersModule` import solely for a single
 * column. The SalesService follows the exact same pattern (see the
 * `customer.findUnique` call in `assignCustomer`).
 *
 * Why no `ProductsService` injection in WU2: Item-management methods
 * (`addItem`, `removeItem`, etc.) are WU3. WU2 only touches the draft
 * header fields and the lazy EXPIRED transition, neither of which
 * needs products.
 *
 * Why no `PosEvaluatePromotions` injection in WU2: `recomputePricingAndPromotions`
 * is a no-op stub here — the real engine call lands in WU3 along with
 * the `context='QUOTATION'` widening. We deliberately avoid pulling in
 * the PromotionsModule dependency at this layer to keep WU2 a clean
 * revert boundary (T021).
 */
import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { Quotation } from '../domain/quotation.entity';
import {
  type AssignCustomerInput,
  type CreateQuotationInput,
  type QuotationFindAllInput,
  type QuotationListResult,
  type SetPriceListInput,
  QUOTATION_REPOSITORY,
  IQuotationRepository,
} from '../domain/quotation.repository';
import { QuotationNotFoundError } from '../domain/quotation.errors';
import {
  EntityNotFoundError,
  BusinessRuleViolationError,
} from '../../shared/domain/domain-error';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { QuotationResponseDto } from '../dto/quotation-response.dto';

@Injectable()
export class QuotationsService {
  constructor(
    @Inject(QUOTATION_REPOSITORY)
    private readonly quotationRepo: IQuotationRepository,
    private readonly tenantPrisma: TenantPrismaService,
  ) {}

  // ──────────────────────────────────────────────────────────────────
  // Use cases
  // ──────────────────────────────────────────────────────────────────

  /**
   * Open a new DRAFT quotation.
   *
   * When `input.customerId` is provided the service:
   *   1. Verifies the customer exists in the current tenant
   *      (else `EntityNotFoundError` → 404).
   *   2. Auto-seeds `globalPriceListId` from `customer.globalPriceListId`
   *      UNLESS the caller passed an explicit `input.globalPriceListId`
   *      (cashier's explicit choice — `priceListExplicitlySet` flips to
   *      true so a future `assignCustomer` does NOT re-seed).
   *
   * The recompute step is intentionally skipped — an empty draft has
   * no items, so there is nothing to reprice or re-evaluate. WU3 wires
   * the recompute into `assignCustomer` + `setPriceList` once items
   * exist.
   */
  async openDraft(
    sellerUserId: string,
    input: CreateQuotationInput = {},
  ): Promise<QuotationResponseDto> {
    let seededCustomerId: string | null = null;
    let seededPriceListId: string | null = null;
    let priceListExplicitlySet = false;

    if (input.customerId) {
      const customer = await this.findCustomerOrFail(input.customerId);
      seededCustomerId = customer.id;
      // Cashier-explicit override wins. The assignCustomer path follows
      // the same rule (entity-side `priceListExplicitlySet` guard).
      if (input.globalPriceListId) {
        seededPriceListId = input.globalPriceListId;
        priceListExplicitlySet = true;
      } else {
        seededPriceListId = customer.globalPriceListId ?? null;
        priceListExplicitlySet = false;
      }
    } else if (input.globalPriceListId) {
      // Customerless draft with an explicit list binding.
      seededPriceListId = input.globalPriceListId;
      priceListExplicitlySet = true;
    }

    const draft = Quotation.create({
      id: randomUUID(),
      sellerUserId,
      customerId: seededCustomerId ?? null,
      globalPriceListId: seededPriceListId ?? null,
    });

    if (priceListExplicitlySet && seededPriceListId !== null) {
      // Mark the cashier's explicit choice on the freshly-built entity
      // — `Quotation.create()` defaults `priceListExplicitlySet=false`.
      draft.setGlobalPriceList(seededPriceListId, true);
    }

    const persisted = await this.quotationRepo.save(draft);
    return this.toResponse(persisted);
  }

  /**
   * Assign a customer to an existing DRAFT quotation.
   *
   * Mirrors `SalesService.assignCustomer` minus the
   * shipping-address / outbox paths that don't apply to quotations.
   *
   * Order of operations:
   *   1. Load the draft (404 if absent in the current tenant).
   *   2. Verify the status is DRAFT (422 if not).
   *   3. Verify the customer exists (404 if absent).
   *   4. Seed `globalPriceListId` from the customer's default unless
   *      the cashier has already set one explicitly.
   *   5. Recompute (WU2 stub — no-op until WU3).
   *   6. Persist + return the response.
   */
  async assignCustomer(
    id: string,
    input: AssignCustomerInput,
  ): Promise<QuotationResponseDto> {
    const draft = await this.quotationRepo.findById(id);
    if (!draft) {
      throw new QuotationNotFoundError(id);
    }
    if (draft.status !== 'DRAFT') {
      throw new BusinessRuleViolationError(
        `Quotation is in ${draft.status} status; mutation is not allowed`,
        'QUOTATION_NOT_DRAFT',
      );
    }

    const customer = await this.findCustomerOrFail(input.customerId);

    // Auto-seed the price list — only when the cashier has NOT already
    // explicitly chosen one. The entity's `assignCustomer` enforces the
    // same invariant on the write side; the service-side pre-read here
    // is informational so we don't read the customer list twice.
    if (!draft.priceListExplicitlySet && customer.globalPriceListId) {
      draft.setGlobalPriceList(customer.globalPriceListId, false);
    }

    draft.assignCustomer(customer.id, draft.globalPriceListId);

    await this.recomputePricingAndPromotions(draft);
    const persisted = await this.quotationRepo.save(draft);
    return this.toResponse(persisted);
  }

  /**
   * Override the draft's price list.
   *
   * Mirrors `SalesService.setSalePriceList` (WU3 task 3.4) but for the
   * quotation aggregate. The unknown-list rejection is enforced here
   * (returns `BusinessRuleViolationError` → 400 — mirrors
   * `PRICE_LIST_NOT_FOUND`); on rejection we do NOT mutate the draft,
   * so the cashier can correct the payload without losing prior state.
   *
   * WU2 — the recompute is wired but is a no-op. The entity-level
   * pricing invariants (`priceListExplicitlySet` flag, `setGlobalPriceList`)
   * are the only side effects on the aggregate today.
   */
  async setPriceList(
    id: string,
    input: SetPriceListInput,
  ): Promise<QuotationResponseDto> {
    const draft = await this.quotationRepo.findById(id);
    if (!draft) {
      throw new QuotationNotFoundError(id);
    }
    if (draft.status !== 'DRAFT') {
      throw new BusinessRuleViolationError(
        `Quotation is in ${draft.status} status; mutation is not allowed`,
        'QUOTATION_NOT_DRAFT',
      );
    }

    if (input.globalPriceListId !== undefined && input.globalPriceListId !== null) {
      // Catalog existence check — mirrors sale.setSalePriceList but the
      // code label is `PRICE_LIST_NOT_FOUND` so the DomainExceptionFilter
      // maps to HTTP 400.
      const prisma = this.tenantPrisma.getClient();
      const exists = await prisma.globalPriceList.findUnique({
        where: { id: input.globalPriceListId },
        select: { id: true },
      });
      if (!exists) {
        throw new BusinessRuleViolationError(
          'PRICE_LIST_NOT_FOUND',
          'PRICE_LIST_NOT_FOUND',
        );
      }
    }

    draft.setGlobalPriceList(input.globalPriceListId ?? null, true);

    await this.recomputePricingAndPromotions(draft);
    const persisted = await this.quotationRepo.save(draft);
    return this.toResponse(persisted);
  }

  /**
   * Single-quotation read with the lazy EXPIRED transition.
   *
   * The transition is applied by the domain's `getEffectiveStatus`
   * (entity-level, idempotent across N reads). The wire shape keeps
   * both `status` (persisted) AND `effectiveStatus` (lazy-resolved)
   * so the FE can render the badge without re-computing.
   *
   * Tenant scoping: the repository's `findById` is tenant-scoped; a
   * cross-tenant id returns `null` which we translate to 404.
   */
  async findOne(id: string): Promise<QuotationResponseDto> {
    const draft = await this.quotationRepo.findById(id);
    if (!draft) {
      throw new QuotationNotFoundError(id);
    }
    return this.toResponse(draft);
  }

  /**
   * Paginated list with optional filters.
   *
   * The repository handles the SQL pagination + filters
   * (status / customerId / date range + sort). The service then walks
   * every row and surfaces the lazy `effectiveStatus` on each. SENT
   * drafts whose `expiresAt` is in the past collapse to EXPIRED on
   * the wire — the upstream status filter still matches the
   * *persisted* status (so a status='EXPIRED' filter would not
   * surface expired-but-still-persisted-as-SENT rows today; that is
   * an explicit WU3 follow-up if it becomes a user need).
   */
  async findAll(input: QuotationFindAllInput): Promise<QuotationListResult> {
    const page = Math.max(1, input.page ?? 1);
    const limit = Math.min(100, Math.max(1, input.limit ?? 20));

    const { data, total } = await this.quotationRepo.findAll({
      page,
      limit,
      status: input.status,
      customerId: input.customerId,
      createdFrom: input.createdFrom,
      createdTo: input.createdTo,
      sortBy: input.sortBy ?? 'createdAt',
      sortOrder: input.sortOrder ?? 'desc',
    });

    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

    return {
      data: data.map((d) => this.toResponse(d)),
      pagination: { page, limit, total, totalPages },
    };
  }

  // ──────────────────────────────────────────────────────────────────
  // Internal — helpers
  // ──────────────────────────────────────────────────────────────────

  /**
   * WU2 — Stub. The real pipeline (clear → reprice → eval with
   * `context='QUOTATION'`) lands in WU3, along with the entity-level
   * engine-result appliers. Today it is a deliberate no-op so WU2
   * cleanly reverses (T021 rule-of-three).
   */
  private async recomputePricingAndPromotions(_draft: Quotation): Promise<void> {
    // No-op for WU2 — see class header.
    return Promise.resolve();
  }

  /**
   * Catalog-side guard for `assignCustomer` and `openDraft({customerId})`.
   * We only need two columns (`id`, `globalPriceListId`); reading them
   * directly avoids forcing a `CustomersService` dependency into the
   * service module just for one lookup. The throw maps to 404 via
   * `EntityNotFoundError`.
   */
  private async findCustomerOrFail(
    customerId: string,
  ): Promise<{ id: string; globalPriceListId: string | null }> {
    const prisma = this.tenantPrisma.getClient();
    const row = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, globalPriceListId: true },
    });
    if (!row) {
      throw new EntityNotFoundError('Customer', customerId);
    }
    return {
      id: row.id,
      globalPriceListId: row.globalPriceListId ?? null,
    };
  }

  /**
   * Domain → wire shape. Enriches the entity's own `toResponse()` with
   * the lazy `effectiveStatus` so callers don't have to recompute. The
   * entity carries the persisted status verbatim; the lazy field is a
   * pure view-only addition.
   */
  private toResponse(draft: Quotation): QuotationResponseDto {
    const wire = draft.toResponse();
    return {
      ...wire,
      effectiveStatus: draft.getEffectiveStatus(),
    } as QuotationResponseDto;
  }
}
