/**
 * quotation-sale-conversion / T1 — persistence primitives the conversion
 * use cases need beyond the quotation / sale aggregates:
 *
 *   - Idempotency slots on the shared `sale_idempotency` table, using the
 *     SAME conflict-safe protocol as the POS charge / payment / cancel paths
 *     (`INSERT … ON CONFLICT DO NOTHING` inside the caller's transaction,
 *     then one resolve read). Two new `operation` discriminators keep the
 *     keys in their own namespace: a key reused across operations never
 *     collides.
 *   - A tenant-qualified `FOR UPDATE` lock on the quotation row and the
 *     compare-and-set that flips it to CONVERTED_TO_SALE with its link.
 *   - Read-only "can this draft sale be discarded" checks (S3).
 *
 * Every method MUST run inside `TenantPrismaService.runInTransaction` — the
 * locks and the idempotency slot are only meaningful within the caller's
 * transaction, and a rollback releases the slot so the key can retry.
 */
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';

import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';

export type ConversionIdempotencyOperation =
  | 'quotation_from_sale'
  | 'quotation_to_sale';

export type ConversionIdempotencyOutcome =
  | { kind: 'acquired'; token: string }
  | { kind: 'replay'; payload: unknown }
  | { kind: 'conflict' }
  | { kind: 'in_flight' };

export type SaleDiscardBlocker =
  | 'SALE_HAS_PAYMENTS'
  | 'SALE_HAS_STOCK_MOVEMENTS'
  | 'SALE_NOT_DISCARDABLE';

@Injectable()
export class PrismaQuotationSaleConversionStore {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private requireTransaction(): void {
    if (!this.tenantPrisma.isInTransaction()) {
      throw new BusinessRuleViolationError(
        'CONVERSION_REQUIRES_TRANSACTION',
        'CONVERSION_REQUIRES_TRANSACTION',
      );
    }
  }

  // ── Idempotency ───────────────────────────────────────────────────

  async acquireIdempotency(
    operation: ConversionIdempotencyOperation,
    key: string,
    requestHash: string,
  ): Promise<ConversionIdempotencyOutcome> {
    this.requireTransaction();
    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.tenantPrisma.getTenantId();
    const token = randomUUID();

    // Conflict-safe insert: a concurrent holder of the same key makes this
    // statement WAIT on the unique index until it commits / rolls back, so
    // a same-key retry resolves to `replay` (or acquires after a rollback)
    // instead of running the conversion twice.
    const inserted = await prisma.saleIdempotency.createMany({
      data: [
        {
          id: token,
          tenantId,
          operation,
          key,
          requestHash,
          status: 'IN_FLIGHT',
          saleId: null,
        },
      ],
      skipDuplicates: true,
    });
    if (inserted.count === 1) {
      return { kind: 'acquired', token };
    }

    const existing = await prisma.saleIdempotency.findUnique({
      where: { tenantId_operation_key: { tenantId, operation, key } },
    });
    if (!existing) {
      throw new BusinessRuleViolationError(
        'IDEMPOTENCY_STATE_NOT_FOUND',
        'IDEMPOTENCY_STATE_NOT_FOUND',
      );
    }
    if (existing.requestHash !== requestHash) return { kind: 'conflict' };
    if (existing.status === 'SUCCEEDED' && existing.responseJson) {
      return { kind: 'replay', payload: existing.responseJson };
    }
    return { kind: 'in_flight' };
  }

  async markIdempotencySucceeded(
    token: string,
    saleId: string | null,
    payload: unknown,
  ): Promise<void> {
    this.requireTransaction();
    const prisma = this.tenantPrisma.getClient();
    await prisma.saleIdempotency.updateMany({
      where: { id: token, tenantId: this.tenantPrisma.getTenantId() },
      data: {
        status: 'SUCCEEDED',
        responseJson: payload as Prisma.InputJsonValue,
        saleId,
      },
    });
  }

  // ── Quotation row lock + CAS ──────────────────────────────────────

  /** Tenant-qualified row lock. Returns false when the row is not visible. */
  async lockQuotation(quotationId: string): Promise<boolean> {
    this.requireTransaction();
    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.tenantPrisma.getTenantId();
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM quotations
      WHERE id = ${quotationId} AND "tenantId" = ${tenantId}
      FOR UPDATE
    `;
    return rows.length === 1;
  }

  /**
   * Compare-and-set the conversion: only a DRAFT / SENT row, or a converted
   * row whose sale was discarded (NULL link), flips. The row lock already
   * serializes converters; the CAS + the UNIQUE index on `convertedSaleId`
   * are the second and third lines of defense.
   */
  async markQuotationConverted(
    quotationId: string,
    saleId: string,
    convertedAt: Date,
  ): Promise<boolean> {
    this.requireTransaction();
    const prisma = this.tenantPrisma.getClient();
    const updated = await prisma.quotation.updateMany({
      where: {
        id: quotationId,
        tenantId: this.tenantPrisma.getTenantId(),
        OR: [
          { status: { in: ['DRAFT', 'SENT'] } },
          { status: 'CONVERTED_TO_SALE', convertedSaleId: null },
        ],
      },
      data: {
        status: 'CONVERTED_TO_SALE',
        convertedSaleId: saleId,
        convertedAt,
        updatedAt: convertedAt,
      },
    });
    return updated.count === 1;
  }

  // ── Draft sale discard guards (S3) ────────────────────────────────

  /**
   * First reason the (already locked, DRAFT) sale must NOT be discarded,
   * or null when nothing money- or inventory-related hangs off it.
   */
  async findSaleDiscardBlocker(
    saleId: string,
  ): Promise<SaleDiscardBlocker | null> {
    this.requireTransaction();
    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.tenantPrisma.getTenantId();

    const [payments, refunds, receipts] = await Promise.all([
      prisma.salePayment.count({ where: { saleId, tenantId } }),
      prisma.saleRefund.count({ where: { saleId, tenantId } }),
      prisma.receiptEvidence.count({ where: { saleId, tenantId } }),
    ]);
    if (payments + refunds + receipts > 0) return 'SALE_HAS_PAYMENTS';

    const movements = await prisma.stockMovement.count({
      where: { tenantId, groupType: 'SALE', groupId: saleId },
    });
    if (movements > 0) return 'SALE_HAS_STOCK_MOVEMENTS';

    const [routeStops, usages] = await Promise.all([
      prisma.deliveryRouteStop.count({ where: { saleId, tenantId } }),
      prisma.promotionUsage.count({ where: { saleId, tenantId } }),
    ]);
    if (routeStops + usages > 0) return 'SALE_NOT_DISCARDABLE';

    return null;
  }

  // ── Lookups ───────────────────────────────────────────────────────

  /** Titles of the given promotions within the tenant (missing ids omitted). */
  async findPromotionTitles(
    promotionIds: ReadonlyArray<string>,
  ): Promise<Map<string, string>> {
    const distinct = [...new Set(promotionIds)];
    if (distinct.length === 0) return new Map();
    const rows = await this.tenantPrisma.getClient().promotion.findMany({
      where: {
        id: { in: distinct },
        tenantId: this.tenantPrisma.getTenantId(),
      },
      select: { id: true, title: true },
    });
    return new Map(rows.map((row) => [row.id, row.title]));
  }
}
