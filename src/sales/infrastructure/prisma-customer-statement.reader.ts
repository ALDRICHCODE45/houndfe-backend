/**
 * ADAPTER: PrismaCustomerStatementReader (sales-history-redesign S11).
 *
 * One `tenantPrisma.runInTransaction(work, 'RepeatableRead')` owns the whole
 * read (customer, period sales, open-debt sales, period payments), like the
 * seller report repository, so totals and lists come from one snapshot.
 * `getClient()` is read INSIDE the callback (ambient transaction client). Raw
 * SQL bypasses the CLS tenant extension, so every source carries an explicit
 * `"tenantId" = $N`.
 *
 * `confirmedAt` and `sale_payments."createdAt"` are UTC-naive `timestamp(3)`;
 * local `[from, to)` bounds use the double `AT TIME ZONE` (zone, then UTC) and
 * local days `AT TIME ZONE 'UTC' AT TIME ZONE <zone>`.
 */
import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type {
  CustomerStatementRange,
  CustomerStatementSnapshot,
  ICustomerStatementReader,
} from '../domain/customer-statement.reader';

type Raw = Record<string, unknown>;

const toInt = (value: unknown): number => Number(value);
const toText = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

@Injectable()
export class PrismaCustomerStatementReader implements ICustomerStatementReader {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  read(
    customerId: string,
    range: CustomerStatementRange,
  ): Promise<CustomerStatementSnapshot | null> {
    return this.tenantPrisma.runInTransaction(
      () => this.readSnapshot(customerId, range),
      'RepeatableRead',
    );
  }

  private async readSnapshot(
    customerId: string,
    { from, to, timeZone }: CustomerStatementRange,
  ): Promise<CustomerStatementSnapshot | null> {
    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.tenantPrisma.getTenantId();

    const customers = await prisma.$queryRaw<Raw[]>`
      SELECT c."id", c."firstName", c."lastName", c."phoneCountryCode", c."phone",
        c."email", c."rfc", c."businessName", t."name" AS "branchName"
      FROM "customers" c
      JOIN "tenants" t ON t."id" = c."tenantId"
      WHERE c."id" = ${customerId} AND c."tenantId" = ${tenantId}
    `;
    if (customers.length !== 1) return null;
    const c = customers[0];

    const periodSales = await prisma.$queryRaw<Raw[]>`
      SELECT s."id", s."folio", s."confirmedAt", s."totalCents", s."paidCents",
        s."openDebtCents", s."dueDate", s."paymentStatus"::text AS "paymentStatus",
        to_char((s."confirmedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${timeZone})::date, 'YYYY-MM-DD') AS "localDate"
      FROM "sales" s
      WHERE s."tenantId" = ${tenantId} AND s."customerId" = ${customerId}
        AND s."status" = 'CONFIRMED' AND s."confirmedAt" IS NOT NULL
        AND s."confirmedAt" >= ((${from}::date::timestamp AT TIME ZONE ${timeZone}) AT TIME ZONE 'UTC')
        AND s."confirmedAt" < ((${to}::date::timestamp AT TIME ZONE ${timeZone}) AT TIME ZONE 'UTC')
      ORDER BY s."confirmedAt" ASC, s."id" ASC
    `;

    const openDebtSales = await prisma.$queryRaw<Raw[]>`
      SELECT s."id", s."dueDate", s."openDebtCents"
      FROM "sales" s
      WHERE s."tenantId" = ${tenantId} AND s."customerId" = ${customerId}
        AND s."status" = 'CONFIRMED' AND s."openDebtCents" > 0
      ORDER BY s."dueDate" ASC NULLS LAST, s."id" ASC
    `;

    // Received money only: `sale_payments` rows. Refund obligations and their
    // settlements live in other tables and are not read here.
    const payments = await prisma.$queryRaw<Raw[]>`
      SELECT p."id", p."saleId", s."folio" AS "saleFolio", s."status"::text AS "saleStatus",
        s."changeDueCents" AS "saleChangeDueCents", p."createdAt" AS "paidAt",
        to_char((p."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${timeZone})::date, 'YYYY-MM-DD') AS "localDate",
        p."method"::text AS "method", p."amountCents",
        CASE
          WHEN jsonb_typeof(p."metadataJson"->'catalog'->'paymentMethodId') = 'string'
            AND jsonb_typeof(p."metadataJson"->'catalog'->'name') = 'string'
          THEN p."metadataJson"->'catalog'->>'name'
        END AS "catalogName"
      FROM "sale_payments" p
      JOIN "sales" s ON s."id" = p."saleId" AND s."tenantId" = ${tenantId}
      WHERE p."tenantId" = ${tenantId} AND s."customerId" = ${customerId}
        AND p."createdAt" >= ((${from}::date::timestamp AT TIME ZONE ${timeZone}) AT TIME ZONE 'UTC')
        AND p."createdAt" < ((${to}::date::timestamp AT TIME ZONE ${timeZone}) AT TIME ZONE 'UTC')
      ORDER BY p."createdAt" ASC, p."id" ASC
    `;

    return {
      branchName: String(c['branchName']),
      customer: {
        id: String(c['id']),
        firstName: String(c['firstName']),
        lastName: toText(c['lastName']),
        phoneCountryCode: toText(c['phoneCountryCode']),
        phone: toText(c['phone']),
        email: toText(c['email']),
        rfc: toText(c['rfc']),
        businessName: toText(c['businessName']),
      },
      periodSales: periodSales.map((row) => ({
        id: String(row['id']),
        folio: toText(row['folio']),
        confirmedAt: row['confirmedAt'] as Date,
        localDate: String(row['localDate']),
        totalCents: toInt(row['totalCents']),
        paidCents: toInt(row['paidCents']),
        openDebtCents: toInt(row['openDebtCents']),
        dueDate: (row['dueDate'] as Date | null) ?? null,
        paymentStatus: toText(
          row['paymentStatus'],
        ) as CustomerStatementSnapshot['periodSales'][number]['paymentStatus'],
      })),
      openDebtSales: openDebtSales.map((row) => ({
        id: String(row['id']),
        dueDate: (row['dueDate'] as Date | null) ?? null,
        openDebtCents: toInt(row['openDebtCents']),
      })),
      payments: payments.map((row) => ({
        id: String(row['id']),
        saleId: String(row['saleId']),
        saleFolio: toText(row['saleFolio']),
        saleStatus: String(row['saleStatus']),
        saleChangeDueCents: toInt(row['saleChangeDueCents']),
        paidAt: row['paidAt'] as Date,
        localDate: String(row['localDate']),
        method: String(row['method']),
        amountCents: toInt(row['amountCents']),
        catalogName: toText(row['catalogName']),
      })),
    };
  }
}
