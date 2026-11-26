/**
 * customer-collection / T3 (S5) — PostgreSQL adapter of `ICollectionReader`.
 *
 * Plain reads, no locks. Every statement carries the tenant explicitly (raw
 * SQL is not tenant-scoped by the client extension).
 *
 * "Up to and including this collection" cut, evaluated IN SQL so the
 * comparison keeps PostgreSQL's microsecond `createdAt` (a JS Date would
 * truncate to ms): a payment counts when it belongs to the collection or was
 * created before the collection row. Both default to `now()`, i.e. the start
 * of their transaction, so the collection row and its payment rows share one
 * instant and every payment committed before the collection started is
 * earlier. Known limit: a single-sale payment whose transaction STARTED
 * before the collection but committed after it (it waited on the sale lock)
 * is counted as before — and vice versa — which can shift the per-sale
 * balance of a re-print in that millisecond race; nothing else does.
 */
import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type {
  CollectionPaymentRecord,
  CollectionRecord,
  CollectionSaleRecord,
  ICollectionReader,
} from '../domain/collection-reader';

interface RawCollection {
  id: string;
  createdAt: Date;
  customerId: string | null;
  firstName: string | null;
  lastName: string | null;
  branchName: string;
  cashierName: string | null;
  tenderedCents: number;
  appliedCents: number;
  changeDueCents: number;
  tendersJson: unknown;
}

@Injectable()
export class PrismaCollectionReader implements ICollectionReader {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async findCollection(collectionId: string): Promise<CollectionRecord | null> {
    const tenantId = this.tenantPrisma.getTenantId();
    const prisma = this.tenantPrisma.getClient();

    const collections = await prisma.$queryRaw<RawCollection[]>`
      SELECT c.id, c."createdAt", c."customerId", cu."firstName", cu."lastName",
        t.name AS "branchName", u.name AS "cashierName",
        c."tenderedCents", c."appliedCents", c."changeDueCents", c."tendersJson"
      FROM sale_collections c
      JOIN tenants t ON t.id = c."tenantId"
      LEFT JOIN customers cu ON cu.id = c."customerId" AND cu."tenantId" = c."tenantId"
      LEFT JOIN users u ON u.id = c."actorUserId"
      WHERE c.id = ${collectionId} AND c."tenantId" = ${tenantId}
    `;
    const collection = collections[0];
    if (!collection) return null;

    const payments = await prisma.$queryRaw<CollectionPaymentRecord[]>`
      SELECT id, "saleId", method::text AS method, "amountCents",
        "metadataJson" -> 'catalog' ->> 'paymentMethodId' AS "catalogPaymentMethodId"
      FROM sale_payments
      WHERE "tenantId" = ${tenantId} AND "collectionId" = ${collectionId}
    `;

    const sales = await prisma.$queryRaw<CollectionSaleRecord[]>`
      SELECT s.id AS "saleId", s.folio, s.status::text AS status,
        s."confirmedAt", s."dueDate", s."totalCents",
        (
          SELECT COALESCE(SUM(p."amountCents"), 0)
          FROM sale_payments p
          WHERE p."tenantId" = s."tenantId" AND p."saleId" = s.id
            AND (p."collectionId" = c.id OR p."createdAt" < c."createdAt")
        )::int AS "paidThroughCents"
      FROM sales s
      JOIN sale_collections c ON c.id = ${collectionId} AND c."tenantId" = ${tenantId}
      WHERE s."tenantId" = ${tenantId}
        AND s.id IN (
          SELECT "saleId" FROM sale_payments
          WHERE "tenantId" = ${tenantId} AND "collectionId" = ${collectionId}
        )
    `;

    let customerDebtAfterCents: number | null = null;
    if (collection.customerId !== null) {
      // The customer's sales CONFIRMED at the collection moment (confirmed
      // before it, not cancelled before it) plus the collection's own sales.
      const debt = await prisma.$queryRaw<Array<{ debtCents: number }>>`
        SELECT COALESCE(SUM(
          s."totalCents" - LEAST(s."totalCents", (
            SELECT COALESCE(SUM(p."amountCents"), 0)
            FROM sale_payments p
            WHERE p."tenantId" = s."tenantId" AND p."saleId" = s.id
              AND (p."collectionId" = c.id OR p."createdAt" < c."createdAt")
          ))
        ), 0)::int AS "debtCents"
        FROM sales s
        JOIN sale_collections c ON c.id = ${collectionId} AND c."tenantId" = ${tenantId}
        WHERE s."tenantId" = ${tenantId}
          AND s."customerId" = c."customerId"
          AND (
            EXISTS (
              SELECT 1 FROM sale_payments cp
              WHERE cp."tenantId" = ${tenantId} AND cp."collectionId" = c.id
                AND cp."saleId" = s.id
            )
            OR (
              s."confirmedAt" IS NOT NULL AND s."confirmedAt" <= c."createdAt"
              AND (
                s.status = 'CONFIRMED'
                OR (s.status = 'CANCELED' AND s."canceledAt" > c."createdAt")
              )
            )
          )
      `;
      customerDebtAfterCents = Number(debt[0]?.debtCents ?? 0);
    }

    return {
      id: collection.id,
      createdAt: collection.createdAt,
      customer:
        collection.customerId !== null && collection.firstName !== null
          ? {
              id: collection.customerId,
              // Same rendering as the POST (`GET /sales` row customer).
              name: collection.lastName
                ? `${collection.firstName} ${collection.lastName}`
                : collection.firstName,
            }
          : null,
      branchName: collection.branchName,
      cashierName: collection.cashierName,
      tenderedCents: Number(collection.tenderedCents),
      appliedCents: Number(collection.appliedCents),
      changeDueCents: Number(collection.changeDueCents),
      tendersJson: collection.tendersJson,
      payments: payments.map((payment) => ({
        ...payment,
        amountCents: Number(payment.amountCents),
      })),
      sales: sales.map((sale) => ({
        ...sale,
        totalCents: Number(sale.totalCents),
        paidThroughCents: Number(sale.paidThroughCents),
      })),
      customerDebtAfterCents,
    };
  }
}
