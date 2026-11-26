/**
 * customer-collection / T2 (S2, S3, S4) — «Cobrar todo»: one payment spread
 * over several open-debt sales of one customer (contract v1 §2–§6, §9, §10;
 * owner Q1–Q4, Q6, Q7).
 *
 * Preview: plain reads (no locks, no idempotency, no writes) and the pure
 * allocation (`domain/collection-allocation.ts`).
 *
 * Apply, ONE transaction:
 *   1. idempotency acquire (`customer_collection`, `saleId` null). It runs
 *      BEFORE the session fence — the order of `POST /sales/:id/payments`, and
 *      deliberately different from the contract §5 listing — so a same-key
 *      replay still answers the stored 200 after the session is frozen; a
 *      rejected fence rolls the freshly acquired slot back with everything;
 *   2. cash session fence (`assertOpenSession`: tenant, owner, OPEN; locks the
 *      session row);
 *   3. customer row `FOR KEY SHARE`, then the sales `FOR UPDATE ORDER BY id`
 *      (customer DELETE order): with `saleIds` the selection; without it
 *      only the sales the tender reaches (candidates read unlocked in Q1
 *      order, see `lockReachedSales`). Allocation recomputed under the lock;
 *      a reached set that no longer matches the locked one, or a different
 *      `expectedDebtCents`, answers 409 with the current preview;
 *   4. `sale_collections` row, then per sale the `SalePayment` rows (one per
 *      (sale, tender part), applied amount, `collectionId`) through the
 *      single-sale writer, which re-sums the ledger and updates
 *      paid/debt/status;
 *   5. cash movements: one `SALE_PAYMENT` per payment row and one
 *      `SALE_CHANGE` for the collection (source id = the collection id);
 *   6. outbox: per-sale `sale.payment.received` / `sale.fully.paid` as today
 *      (tagged with `collectionId`) plus one `customer.collection.recorded`;
 *   7. idempotency slot SUCCEEDED with the response.
 *
 * Cash and change (Q3): the payment rows hold APPLIED amounts, so the cash
 * that comes back as change is not on any row. To keep the drawer right
 * (+tendered cash − change = applied cash) the ledger movement of the LAST
 * applied cash part carries the change on top of its applied amount, and the
 * `SALE_CHANGE` row takes it out. When no cash part was applied at all (the
 * non-cash tenders covered the debt, every cash cent is change) the cash
 * never entered the drawer: no cash movement and no `SALE_CHANGE`; the change
 * stays recorded on the collection.
 *
 * Q4: anyone with `update:Sale` collects any sale of the customer (no
 * own-POS-sale rule). There is no reviewer (bot) entry point to this service.
 * S4/Q6: no listener notifies the CUSTOMER on `sale.payment.received` /
 * `sale.fully.paid` today (only the audit log listener), so the per-sale
 * events stay as they are and `customer.collection.recorded` is the single
 * collection-level event a future customer notice must hang from.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'crypto';
import {
  IPaymentMethodResolver,
  PAYMENT_METHOD_RESOLVER,
} from '../admin/payment-methods/domain/payment-method.resolver';
import {
  CASH_LEDGER,
  type CashLedgerPayment,
  type ICashLedger,
} from '../cash-register/cash-ledger.port';
import { businessToday } from '../inventory/domain/fefo-allocator';
import { BusinessRuleViolationError } from '../shared/domain/domain-error';
import { OutboxWriterService } from '../shared/outbox/outbox-writer.service';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import { isOverdue } from './customer-statement.service';
import {
  allocateCollection,
  collectionLockPrefix,
  type CollectionAllocation,
  type CollectionTenderMethod,
} from './domain/collection-allocation';
import {
  CUSTOMER_COLLECTION_REPOSITORY,
  type CollectionCustomer,
  type CollectionSaleRow,
  type ICustomerCollectionRepository,
} from './domain/customer-collection.repository';
import {
  SALE_REPOSITORY,
  type ISaleRepository,
} from './domain/sale.repository';
import type {
  CollectionCatalogSnapshotDto,
  CollectionPreviewResponseDto,
  CollectionResponseDto,
  CollectionSaleResponseDto,
  CollectionTenderResponseDto,
  CreateCustomerCollectionDto,
  CustomerCollectionPreviewDto,
} from './dto/customer-collection.dto';
import {
  publishSaleFullyPaidEvent,
  publishSalePaymentReceivedEvents,
} from './sale-payment-events';
import {
  SALES_CLOCK,
  sortPaymentsForHash,
  toCanonicalChargePayments,
} from './sales.service';

const DEFAULT_BUSINESS_TIMEZONE = 'America/Mexico_City';

interface RequestTender {
  method: CollectionTenderMethod;
  amountCents: number;
  reference?: string;
  paymentMethodId?: string;
}

/** A tender with its resolved catalog snapshot (`metadataJson.catalog`). */
interface ResolvedTender extends RequestTender {
  metadataJson?: { catalog: CollectionCatalogSnapshotDto };
}

type Allocation = CollectionAllocation<CollectionSaleRow>;

function ruleError(
  code: string,
  details?: Record<string, unknown>,
): BusinessRuleViolationError {
  return new BusinessRuleViolationError(code, code, details);
}

function toRequestTenders(
  payments: ReadonlyArray<RequestTender> | undefined,
): RequestTender[] {
  return (payments ?? []).map((payment) => ({
    method: payment.method,
    amountCents: payment.amountCents,
    ...(payment.reference !== undefined
      ? { reference: payment.reference }
      : {}),
    ...(payment.paymentMethodId !== undefined
      ? { paymentMethodId: payment.paymentMethodId }
      : {}),
  }));
}

@Injectable()
export class CustomerCollectionService {
  constructor(
    @Inject(SALE_REPOSITORY)
    private readonly saleRepo: ISaleRepository,
    @Inject(CUSTOMER_COLLECTION_REPOSITORY)
    private readonly collections: ICustomerCollectionRepository,
    private readonly outboxWriter: OutboxWriterService,
    private readonly tenantPrisma: TenantPrismaService,
    @Inject(PAYMENT_METHOD_RESOLVER)
    private readonly paymentMethodResolver: IPaymentMethodResolver,
    @Optional()
    @Inject(CASH_LEDGER)
    private readonly cashLedger?: ICashLedger,
    @Optional()
    @Inject(SALES_CLOCK)
    private readonly clock?: () => Date,
    @Optional()
    private readonly config?: ConfigService,
  ) {}

  // ─────────────────────────────── preview ───────────────────────────────

  async preview(
    customerId: string,
    dto: CustomerCollectionPreviewDto,
  ): Promise<CollectionPreviewResponseDto> {
    const customer = await this.requireCustomer(customerId, false);
    const candidates = await this.loadCandidates(
      customerId,
      dto.saleIds,
      false,
    );
    const tenders = toRequestTenders(dto.payments);
    const allocation = allocateCollection(candidates, tenders);
    const resolved = await this.resolveTenders(tenders);
    return this.buildPreview(customer, allocation, resolved, dto.saleIds);
  }

  // ──────────────────────────────── apply ────────────────────────────────

  async apply(
    customerId: string,
    actorId: string,
    dto: CreateCustomerCollectionDto,
    idempotencyKey: string,
  ): Promise<{ replayed: boolean; body: CollectionResponseDto }> {
    // Q7 «Sí, obligatorio» — before any transaction, slot or lock.
    const cashSessionId = dto.cashSessionId;
    if (cashSessionId === undefined) {
      throw ruleError('CASH_SESSION_REQUIRED');
    }
    const tenders = toRequestTenders(dto.payments);
    const requestHash = this.requestHash(customerId, actorId, tenders, dto);

    return this.tenantPrisma.runInTransaction(async () => {
      const idempotency = await this.saleRepo.acquireCollectionIdempotency(
        idempotencyKey,
        requestHash,
      );
      if (idempotency.kind === 'replay') {
        return {
          replayed: true,
          body: idempotency.payload as CollectionResponseDto,
        };
      }
      if (idempotency.kind === 'conflict') {
        throw ruleError('IDEMPOTENCY_KEY_CONFLICT');
      }
      if (idempotency.kind === 'in_flight') {
        throw ruleError('IDEMPOTENCY_KEY_IN_FLIGHT');
      }

      const ledger = this.requireCashLedger();
      await ledger.assertOpenSession(cashSessionId, actorId);

      const customer = await this.requireCustomer(customerId, true);
      const { candidates, fitsLockedSet } =
        dto.saleIds === undefined
          ? await this.lockReachedSales(customerId, tenders)
          : {
              candidates: await this.loadCandidates(
                customerId,
                dto.saleIds,
                true,
              ),
              fitsLockedSet: () => true,
            };
      // Allocation errors under the lock (NO_OPEN_DEBT, EXCEEDS_DEBT,
      // SALE_NOT_ELIGIBLE) answer before the debt-changed checks.
      const allocation = allocateCollection(candidates, tenders);
      const resolved = await this.resolveTenders(tenders);

      if (
        !fitsLockedSet(allocation) ||
        (dto.expectedDebtCents !== undefined &&
          dto.expectedDebtCents !== allocation.debtCents)
      ) {
        throw ruleError('COLLECTION_DEBT_CHANGED', {
          preview: await this.buildPreview(
            customer,
            allocation,
            resolved,
            dto.saleIds,
          ),
        });
      }

      const body = await this.write({
        customer,
        actorId,
        cashSessionId,
        allocation,
        resolved,
        saleIds: dto.saleIds,
        ledger,
      });
      await this.saleRepo.markCollectionIdempotencySucceeded(
        idempotency.token,
        body,
      );
      return { replayed: false, body };
    });
  }

  private async write(input: {
    customer: CollectionCustomer;
    actorId: string;
    cashSessionId: string;
    allocation: Allocation;
    resolved: ResolvedTender[];
    saleIds: readonly string[] | undefined;
    ledger: ICashLedger;
  }): Promise<CollectionResponseDto> {
    const { customer, actorId, cashSessionId, allocation, resolved } = input;
    const tenantId = this.tenantPrisma.getTenantId();
    const client = this.tenantPrisma.getClient();
    const today = this.today();
    // Payment events, cash movements and `customer.collection.recorded`.
    const occurredAt = this.now();
    const collectionId = randomUUID();
    const tendersJson = this.tenderResponses(resolved);
    // Read BEFORE the writes: with a selection it sums the customer's open
    // debt, which the payment rows below are about to reduce.
    const remainingCustomerDebtCents = await this.remainingDebt(
      customer.id,
      allocation,
      input.saleIds,
    );

    const { createdAt } = await this.collections.insertCollection({
      id: collectionId,
      customerId: customer.id,
      actorUserId: actorId,
      cashSessionId,
      tenderedCents: allocation.tenderedCents,
      appliedCents: allocation.appliedCents,
      changeDueCents: allocation.changeDueCents,
      tendersJson,
    });

    const ledgerPayments: CashLedgerPayment[] = [];
    const sales: CollectionResponseDto['sales'] = [];
    for (const share of allocation.sales) {
      if (share.appliedCents === 0) continue;
      const sale = share.candidate;
      const rows = share.parts.map((part) => {
        const tender = resolved[part.tenderIndex];
        return {
          method: part.method,
          amountCents: part.amountCents,
          reference: tender.reference,
          metadataJson: tender.metadataJson,
        };
      });
      const updated = await this.saleRepo.persistCollectedPayments({
        saleId: sale.saleId,
        userId: actorId,
        collectionId,
        payments: rows,
      });
      // The locked row and the writer's ledger re-sum must agree; anything
      // else is an inconsistent sale and the whole collection rolls back.
      if (
        updated.paidCents !== sale.paidCents + share.appliedCents ||
        updated.debtCents !== sale.debtCents - share.appliedCents
      ) {
        throw new Error(`COLLECTION_LEDGER_MISMATCH: sale ${sale.saleId}`);
      }

      rows.forEach((payment, index) => {
        ledgerPayments.push({
          paymentId: updated.paymentIds[index],
          method: payment.method,
          amountCents: payment.amountCents,
          metadataJson: payment.metadataJson,
        });
      });

      await publishSalePaymentReceivedEvents(this.outboxWriter, client, {
        saleId: sale.saleId,
        tenantId,
        actorId,
        payments: rows.map((payment, index) => ({
          paymentId: updated.paymentIds[index],
          method: payment.method,
          amountCents: payment.amountCents,
          reference: payment.reference ?? null,
        })),
        paidCents: updated.paidCents,
        debtCents: updated.debtCents,
        occurredAt,
        resultingPaymentStatus: updated.paymentStatus,
        collectionId,
      });
      if (updated.debtCents === 0) {
        await publishSaleFullyPaidEvent(this.outboxWriter, client, {
          saleId: sale.saleId,
          tenantId,
          folio: sale.folio ?? 'N/A',
          totalCents: updated.totalCents,
          paidAt: occurredAt,
          collectionId,
        });
      }

      sales.push({
        ...this.saleBase(sale, today),
        appliedCents: share.appliedCents,
        paidCents: updated.paidCents,
        debtCents: updated.debtCents,
        paymentStatus: updated.paymentStatus,
        paymentIds: updated.paymentIds,
      });
    }

    // Cash: the last applied cash part carries the change (see the header).
    let ledgerChangeCents = 0;
    if (allocation.changeDueCents > 0) {
      const lastCash = ledgerPayments
        .map((payment) => payment.method)
        .lastIndexOf('cash');
      if (lastCash >= 0) {
        ledgerPayments[lastCash] = {
          ...ledgerPayments[lastCash],
          amountCents:
            ledgerPayments[lastCash].amountCents + allocation.changeDueCents,
        };
        ledgerChangeCents = allocation.changeDueCents;
      }
    }
    await input.ledger.recordPayments({
      sessionId: cashSessionId,
      actorId,
      // The SALE_CHANGE source id: one change per collection.
      saleId: collectionId,
      payments: ledgerPayments,
      changeDueCents: ledgerChangeCents,
      occurredAt,
    });

    const body: CollectionResponseDto = {
      collectionId,
      customer: { id: customer.id, name: customer.name },
      createdAt: createdAt.toISOString(),
      tenderedCents: allocation.tenderedCents,
      appliedCents: allocation.appliedCents,
      changeDueCents: allocation.changeDueCents,
      payments: tendersJson,
      sales,
      remainingCustomerDebtCents,
    };

    await this.outboxWriter.publish(
      client,
      tenantId,
      'SaleCollection',
      collectionId,
      'customer.collection.recorded',
      {
        collectionId,
        tenantId,
        customerId: customer.id,
        actorId,
        cashSessionId,
        tenderedCents: allocation.tenderedCents,
        appliedCents: allocation.appliedCents,
        changeDueCents: allocation.changeDueCents,
        remainingCustomerDebtCents,
        sales: sales.map((sale) => ({
          saleId: sale.saleId,
          folio: sale.folio,
          appliedCents: sale.appliedCents,
          paidCents: sale.paidCents,
          debtCents: sale.debtCents,
          paymentStatus: sale.paymentStatus,
          paymentIds: sale.paymentIds,
        })),
        occurredAt: occurredAt.toISOString(),
      },
    );

    return body;
  }

  // ─────────────────────────────── helpers ───────────────────────────────

  private requireCashLedger(): ICashLedger {
    if (!this.cashLedger) {
      throw ruleError('CASH_LEDGER_UNAVAILABLE');
    }
    return this.cashLedger;
  }

  private async requireCustomer(
    customerId: string,
    lock: boolean,
  ): Promise<CollectionCustomer> {
    const customer = await this.collections.findCustomer(customerId, { lock });
    if (!customer) {
      throw ruleError('CUSTOMER_NOT_FOUND');
    }
    return customer;
  }

  /**
   * Without `saleIds`: lock only the sales the tender reaches (R4).
   *
   * The candidates are read WITHOUT locks in Q1 order, the reached prefix
   * (`collectionLockPrefix`: every candidate when the tender covers the whole
   * debt) is locked `FOR UPDATE ORDER BY id`, and the allocation runs over
   * the locked prefix plus the unlocked rest — the customer's debt as read in
   * this request, which `expectedDebtCents` is compared with. The allocation
   * "fits" only when every locked sale is still eligible and the sales that
   * receive money are exactly the locked ones; otherwise a concurrent writer
   * changed a debt and the caller answers 409 COLLECTION_DEBT_CHANGED with
   * the current preview before any write. A sale that receives 0 is never
   * locked, so a single-sale payment on it does not wait for the collection.
   */
  private async lockReachedSales(
    customerId: string,
    tenders: RequestTender[],
  ): Promise<{
    candidates: CollectionSaleRow[];
    fitsLockedSet: (allocation: Allocation) => boolean;
  }> {
    const unlocked = await this.collections.findOpenDebtSales(customerId, {
      lock: false,
    });
    const tenderedCents = tenders.reduce(
      (total, tender) => total + tender.amountCents,
      0,
    );
    const prefixIds = collectionLockPrefix(unlocked, tenderedCents)
      .map((sale) => sale.saleId)
      .sort();
    const locked =
      prefixIds.length === 0
        ? []
        : await this.collections.findSalesByIds(prefixIds, { lock: true });
    const eligible = locked.filter(
      (sale) =>
        sale.customerId === customerId &&
        sale.status === 'CONFIRMED' &&
        sale.debtCents > 0,
    );
    const prefix = new Set(prefixIds);
    const rest = unlocked.filter((sale) => !prefix.has(sale.saleId));
    return {
      candidates: [...eligible, ...rest],
      fitsLockedSet: (allocation) => {
        if (eligible.length !== prefixIds.length) return false;
        const reached = allocation.sales.filter(
          (share) => share.appliedCents > 0,
        );
        return (
          reached.length === prefix.size &&
          reached.every((share) => prefix.has(share.candidate.saleId))
        );
      },
    };
  }

  /**
   * All the customer's CONFIRMED open-debt sales, or the explicit selection,
   * every selected id checked in request order (§3.1): unknown/foreign,
   * another customer, not CONFIRMED or without debt → NOT_ELIGIBLE + id.
   */
  private async loadCandidates(
    customerId: string,
    saleIds: readonly string[] | undefined,
    lock: boolean,
  ): Promise<CollectionSaleRow[]> {
    if (saleIds === undefined) {
      return this.collections.findOpenDebtSales(customerId, { lock });
    }
    const rows = await this.collections.findSalesByIds(saleIds, { lock });
    const byId = new Map(rows.map((sale) => [sale.saleId, sale]));
    return saleIds.map((saleId) => {
      const sale = byId.get(saleId);
      if (
        !sale ||
        sale.customerId !== customerId ||
        sale.status !== 'CONFIRMED' ||
        sale.debtCents <= 0
      ) {
        throw ruleError('COLLECTION_SALE_NOT_ELIGIBLE', { saleId });
      }
      return sale;
    });
  }

  /** Catalog snapshots exactly as the single-sale route stores them. */
  private async resolveTenders(
    tenders: RequestTender[],
  ): Promise<ResolvedTender[]> {
    const canonical = await toCanonicalChargePayments(
      tenders,
      this.paymentMethodResolver,
      this.tenantPrisma.getTenantId(),
    );
    return tenders.map((tender, index) => {
      const metadata = canonical[index].metadataJson as
        | { catalog: CollectionCatalogSnapshotDto }
        | undefined;
      return metadata ? { ...tender, metadataJson: metadata } : tender;
    });
  }

  private tenderResponses(
    resolved: ResolvedTender[],
  ): CollectionTenderResponseDto[] {
    return resolved.map((tender) => ({
      method: tender.method,
      amountCents: tender.amountCents,
      catalog: tender.metadataJson?.catalog ?? null,
    }));
  }

  private async buildPreview(
    customer: CollectionCustomer,
    allocation: Allocation,
    resolved: ResolvedTender[],
    saleIds: readonly string[] | undefined,
  ): Promise<CollectionPreviewResponseDto> {
    const today = this.today();
    return {
      customer: { id: customer.id, name: customer.name },
      debtCents: allocation.debtCents,
      tenderedCents: allocation.tenderedCents,
      appliedCents: allocation.appliedCents,
      changeDueCents: allocation.changeDueCents,
      payments: this.tenderResponses(resolved),
      sales: allocation.sales.map(({ candidate, appliedCents }) => {
        const paidCents = candidate.paidCents + appliedCents;
        const debtCents = candidate.debtCents - appliedCents;
        return {
          ...this.saleBase(candidate, today),
          appliedCents,
          paidCents,
          debtCents,
          paymentStatus:
            appliedCents === 0
              ? candidate.paymentStatus
              : debtCents === 0
                ? 'PAID'
                : 'PARTIAL',
        };
      }),
      remainingCustomerDebtCents: await this.remainingDebt(
        customer.id,
        allocation,
        saleIds,
      ),
    };
  }

  /** Whole customer debt after the collection (also outside a selection). */
  private async remainingDebt(
    customerId: string,
    allocation: Allocation,
    saleIds: readonly string[] | undefined,
  ): Promise<number> {
    const before =
      saleIds === undefined
        ? allocation.debtCents
        : await this.collections.sumOpenDebt(customerId);
    return before - allocation.appliedCents;
  }

  /** Identity, dates (as the `GET /sales` row renders them) and overdue BEFORE. */
  private saleBase(
    sale: CollectionSaleRow,
    today: string,
  ): Pick<
    CollectionSaleResponseDto,
    'saleId' | 'folio' | 'confirmedAt' | 'dueDate' | 'overdue'
  > {
    return {
      saleId: sale.saleId,
      folio: sale.folio,
      confirmedAt: sale.confirmedAt ? sale.confirmedAt.toISOString() : null,
      dueDate: sale.dueDate ? sale.dueDate.toISOString() : null,
      overdue: isOverdue(sale.dueDate, sale.debtCents, today),
    };
  }

  /** Handoff 28: today's LOCAL date in the business timezone (SALES_CLOCK). */
  private today(): string {
    const timeZone =
      this.config?.get<string>('PROMOTIONS_BUSINESS_TIMEZONE') ??
      DEFAULT_BUSINESS_TIMEZONE;
    return businessToday(this.now(), timeZone);
  }

  /** The injected SALES_CLOCK (tests pin it), else the wall clock. */
  private now(): Date {
    return this.clock ? this.clock() : new Date();
  }

  /**
   * Contract §5.2: `{customerId, actorId, payments (sorted), cashSessionId,
   * saleIds (sorted)?, expectedDebtCents?}` — optional members only when
   * present, so tender and selection order never change the digest.
   */
  private requestHash(
    customerId: string,
    actorId: string,
    tenders: RequestTender[],
    dto: CreateCustomerCollectionDto,
  ): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          customerId,
          actorId,
          payments: sortPaymentsForHash(tenders),
          cashSessionId: dto.cashSessionId,
          ...(dto.saleIds !== undefined
            ? { saleIds: [...dto.saleIds].sort() }
            : {}),
          ...(dto.expectedDebtCents !== undefined
            ? { expectedDebtCents: dto.expectedDebtCents }
            : {}),
        }),
      )
      .digest('hex');
  }
}
