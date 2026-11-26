/**
 * customers-listing T2 (S5, contract §12.3) — PostgreSQL adapter of
 * `ICustomerPaymentsReader`.
 *
 * One `runInTransaction(work, 'RepeatableRead')` owns the whole read
 * (customer check, event page, event count, hydration), so `total` and the
 * page come from one snapshot. `getClient()` is read INSIDE the callback.
 * Raw SQL bypasses the CLS tenant extension, so every table carries an
 * explicit `"tenantId" = $t`.
 *
 * Source: `sale_payments` JOIN `sales` on `sales."customerId"` (the statement
 * join: every sale status, so payments of canceled sales stay). Events are
 * `coalesce("collectionId", id)`; a collection event happens at
 * `sale_collections."createdAt"`. Order `occurredAt DESC, eventId DESC` with
 * `COLLATE "C"` on the id, a total order, so offset pages are stable. The
 * page holds ≤ 100 events and is hydrated with four set-based statements (no
 * N+1), run one after the other on the transaction connection. Refunds (`sale_refunds`, settlements) are never read.
 */
import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import type {
  CustomerCollectionEventRecord,
  CustomerPaymentEventRecord,
  CustomerPaymentsCashierRecord,
  CustomerPaymentsEventRecord,
  CustomerPaymentsPageRecord,
  ICustomerPaymentsReader,
} from './customer-payments.reader';

interface RawEvent {
  eventId: string;
  isCollection: boolean;
}

interface RawCollection {
  id: string;
  createdAt: Date;
  tenderedCents: number;
  appliedCents: number;
  changeDueCents: number;
  tendersJson: unknown;
  actorUserId: string;
  cashierName: string | null;
}

interface RawCollectionSale {
  collectionId: string;
  saleId: string;
  folio: string | null;
  status: string;
  confirmedAt: Date | null;
  dueDate: Date | null;
  appliedCents: number;
}

interface RawPayment {
  id: string;
  createdAt: Date;
  method: string;
  metadataJson: unknown;
  reference: string | null;
  amountCents: number;
  userId: string | null;
  cashierName: string | null;
  saleId: string;
  folio: string | null;
  saleStatus: string;
  totalCents: number;
  changeDueCents: number;
}

interface RawSaleRow {
  id: string;
  saleId: string;
  method: string;
  amountCents: number;
}

/** Legacy rows kept the reference in `metadataJson.reference` (GET /sales/:id rule). */
function legacyReference(metadataJson: unknown): string | null {
  if (!metadataJson || typeof metadataJson !== 'object') return null;
  const candidate = (metadataJson as { reference?: unknown }).reference;
  return typeof candidate === 'string' && candidate.length > 0
    ? candidate
    : null;
}

function cashier(
  id: string | null,
  name: string | null,
): CustomerPaymentsCashierRecord | null {
  return id !== null && name !== null ? { id, name } : null;
}

@Injectable()
export class PrismaCustomerPaymentsReader implements ICustomerPaymentsReader {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  read(
    customerId: string,
    window: { offset: number; limit: number },
  ): Promise<CustomerPaymentsPageRecord | null> {
    return this.tenantPrisma.runInTransaction(
      () => this.readPage(customerId, window),
      'RepeatableRead',
    );
  }

  private async readPage(
    customerId: string,
    { offset, limit }: { offset: number; limit: number },
  ): Promise<CustomerPaymentsPageRecord | null> {
    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.tenantPrisma.getTenantId();

    const customers = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT c.id FROM customers c
      WHERE c.id = ${customerId} AND c."tenantId" = ${tenantId}
    `;
    if (customers.length !== 1) return null;

    const events = await prisma.$queryRaw<RawEvent[]>`
        WITH p AS (
          SELECT sp.id, sp."collectionId", sp."createdAt"
          FROM sale_payments sp
          JOIN sales s ON s.id = sp."saleId" AND s."tenantId" = ${tenantId}
          WHERE sp."tenantId" = ${tenantId} AND s."customerId" = ${customerId}
        ), e AS (
          SELECT coalesce(p."collectionId", p.id) AS "eventId",
            (p."collectionId" IS NOT NULL) AS "isCollection",
            MAX(coalesce(sc."createdAt", p."createdAt")) AS "occurredAt"
          FROM p
          LEFT JOIN sale_collections sc
            ON sc.id = p."collectionId" AND sc."tenantId" = ${tenantId}
          GROUP BY 1, 2
        )
        SELECT e."eventId", e."isCollection" FROM e
        ORDER BY e."occurredAt" DESC, e."eventId" COLLATE "C" DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    const counts = await prisma.$queryRaw<Array<{ total: number }>>`
        SELECT COUNT(DISTINCT coalesce(sp."collectionId", sp.id))::int AS total
        FROM sale_payments sp
        JOIN sales s ON s.id = sp."saleId" AND s."tenantId" = ${tenantId}
        WHERE sp."tenantId" = ${tenantId} AND s."customerId" = ${customerId}
      `;
    const total = Number(counts[0]?.total ?? 0);

    const collectionIds = events
      .filter((event) => event.isCollection)
      .map((event) => event.eventId);
    const paymentIds = events
      .filter((event) => !event.isCollection)
      .map((event) => event.eventId);

    const collections =
      collectionIds.length === 0
        ? []
        : await prisma.$queryRaw<RawCollection[]>`
            SELECT c.id, c."createdAt", c."tenderedCents", c."appliedCents",
              c."changeDueCents", c."tendersJson", c."actorUserId",
              u.name AS "cashierName"
            FROM sale_collections c
            LEFT JOIN users u ON u.id = c."actorUserId"
            WHERE c."tenantId" = ${tenantId} AND c.id = ANY(${collectionIds}::text[])
          `;
    const collectionSales =
      collectionIds.length === 0
        ? []
        : await prisma.$queryRaw<RawCollectionSale[]>`
            SELECT sp."collectionId", s.id AS "saleId", s.folio,
              s.status::text AS status, s."confirmedAt", s."dueDate",
              SUM(sp."amountCents")::int AS "appliedCents"
            FROM sale_payments sp
            JOIN sales s ON s.id = sp."saleId" AND s."tenantId" = ${tenantId}
            WHERE sp."tenantId" = ${tenantId} AND s."customerId" = ${customerId}
              AND sp."collectionId" = ANY(${collectionIds}::text[])
            GROUP BY sp."collectionId", s.id
          `;
    const payments =
      paymentIds.length === 0
        ? []
        : await prisma.$queryRaw<RawPayment[]>`
            SELECT sp.id, sp."createdAt", sp.method::text AS method,
              sp."metadataJson", sp.reference, sp."amountCents", sp."userId",
              u.name AS "cashierName", s.id AS "saleId", s.folio,
              s.status::text AS "saleStatus", s."totalCents", s."changeDueCents"
            FROM sale_payments sp
            JOIN sales s ON s.id = sp."saleId" AND s."tenantId" = ${tenantId}
            LEFT JOIN users u ON u.id = sp."userId"
            WHERE sp."tenantId" = ${tenantId} AND s."customerId" = ${customerId}
              AND sp.id = ANY(${paymentIds}::text[])
          `;

    // Statement change rule input: every row of those sales, payment order.
    const saleIds = [...new Set(payments.map((payment) => payment.saleId))];
    const saleRows =
      saleIds.length === 0
        ? []
        : await prisma.$queryRaw<RawSaleRow[]>`
            SELECT id, "saleId", method::text AS method, "amountCents"
            FROM sale_payments
            WHERE "tenantId" = ${tenantId} AND "saleId" = ANY(${saleIds}::text[])
            ORDER BY "createdAt" ASC, id ASC
          `;

    const collectionById = new Map(collections.map((c) => [c.id, c]));
    const paymentById = new Map(payments.map((p) => [p.id, p]));

    return {
      total,
      events: events.map((event): CustomerPaymentsEventRecord => {
        if (event.isCollection) {
          const c = collectionById.get(event.eventId);
          if (!c) throw new Error('CUSTOMER_PAYMENTS_COLLECTION_MISSING');
          return this.collection(
            c,
            collectionSales.filter((sale) => sale.collectionId === c.id),
          );
        }
        const p = paymentById.get(event.eventId);
        if (!p) throw new Error('CUSTOMER_PAYMENTS_PAYMENT_MISSING');
        return this.payment(
          p,
          saleRows.filter((row) => row.saleId === p.saleId),
        );
      }),
    };
  }

  private collection(
    c: RawCollection,
    sales: RawCollectionSale[],
  ): CustomerCollectionEventRecord {
    return {
      kind: 'collection',
      collectionId: c.id,
      createdAt: c.createdAt,
      tenderedCents: Number(c.tenderedCents),
      appliedCents: Number(c.appliedCents),
      changeDueCents: Number(c.changeDueCents),
      tendersJson: c.tendersJson,
      cashier: cashier(c.actorUserId, c.cashierName),
      sales: sales.map((sale) => ({
        saleId: sale.saleId,
        folio: sale.folio,
        status: sale.status,
        confirmedAt: sale.confirmedAt,
        dueDate: sale.dueDate,
        appliedCents: Number(sale.appliedCents),
      })),
    };
  }

  private payment(
    p: RawPayment,
    rows: RawSaleRow[],
  ): CustomerPaymentEventRecord {
    return {
      kind: 'payment',
      paymentId: p.id,
      createdAt: p.createdAt,
      method: p.method,
      metadataJson: p.metadataJson,
      reference: p.reference ?? legacyReference(p.metadataJson),
      amountCents: Number(p.amountCents),
      cashier: cashier(p.userId, p.cashierName),
      sale: {
        id: p.saleId,
        folio: p.folio,
        status: p.saleStatus,
        totalCents: Number(p.totalCents),
        changeDueCents: Number(p.changeDueCents),
      },
      saleRows: rows.map((row) => ({
        id: row.id,
        method: row.method,
        amountCents: Number(row.amountCents),
      })),
    };
  }
}
