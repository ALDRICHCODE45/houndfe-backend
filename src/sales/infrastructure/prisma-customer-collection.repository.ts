/**
 * customer-collection / T2 — PostgreSQL adapter of the «Cobrar todo» reads,
 * locks and insert. Every statement carries the tenant explicitly (raw SQL is
 * not tenant-scoped by the client extension).
 *
 * Locks (only with `lock: true`, inside the collection transaction):
 * - customer `FOR KEY SHARE`: conflicts with customer DELETE (`FOR UPDATE`),
 *   so the collection and the delete serialize on the customer row before any
 *   sale lock, while two collections of the same customer both pass it and
 *   serialize on their sales;
 * - sales `FOR UPDATE ORDER BY id`: the order customer DELETE uses. Under READ
 *   COMMITTED a row updated meanwhile is re-checked against the predicate and
 *   returned in its latest committed version.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type {
  CollectionCustomer,
  CollectionSaleRow,
  ICustomerCollectionRepository,
} from '../domain/customer-collection.repository';

interface RawSaleRow {
  id: string;
  customerId: string | null;
  status: string;
  folio: string | null;
  confirmedAt: Date | null;
  dueDate: Date | null;
  totalCents: number;
  paidCents: number;
  openDebtCents: number;
  paymentStatus: string | null;
}

const SALE_COLUMNS = Prisma.sql`
  id, "customerId", status::text AS status, folio, "confirmedAt", "dueDate",
  "totalCents", "paidCents", "openDebtCents", "paymentStatus"::text AS "paymentStatus"
`;

function toRow(raw: RawSaleRow): CollectionSaleRow {
  return {
    saleId: raw.id,
    customerId: raw.customerId,
    status: raw.status,
    folio: raw.folio,
    confirmedAt: raw.confirmedAt,
    dueDate: raw.dueDate,
    totalCents: Number(raw.totalCents),
    paidCents: Number(raw.paidCents),
    debtCents: Number(raw.openDebtCents),
    paymentStatus: raw.paymentStatus as CollectionSaleRow['paymentStatus'],
  };
}

@Injectable()
export class PrismaCustomerCollectionRepository implements ICustomerCollectionRepository {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async findCustomer(
    customerId: string,
    options: { lock: boolean },
  ): Promise<CollectionCustomer | null> {
    const tenantId = this.tenantPrisma.getTenantId();
    const lock = options.lock ? Prisma.sql`FOR KEY SHARE` : Prisma.empty;
    const rows = await this.tenantPrisma.getClient().$queryRaw<
      Array<{ id: string; firstName: string; lastName: string | null }>
    >`
      SELECT id, "firstName", "lastName"
      FROM customers
      WHERE id = ${customerId} AND "tenantId" = ${tenantId}
      ${lock}
    `;
    const customer = rows[0];
    if (!customer) return null;
    return {
      id: customer.id,
      // Same rendering as the `GET /sales` row customer.
      name: customer.lastName
        ? `${customer.firstName} ${customer.lastName}`
        : customer.firstName,
    };
  }

  async findOpenDebtSales(
    customerId: string,
    options: { lock: boolean },
  ): Promise<CollectionSaleRow[]> {
    const tenantId = this.tenantPrisma.getTenantId();
    const lock = options.lock ? Prisma.sql`FOR UPDATE` : Prisma.empty;
    const rows = await this.tenantPrisma.getClient().$queryRaw<RawSaleRow[]>`
      SELECT ${SALE_COLUMNS}
      FROM sales
      WHERE "tenantId" = ${tenantId}
        AND "customerId" = ${customerId}
        AND status = 'CONFIRMED'
        AND "openDebtCents" > 0
      ORDER BY id
      ${lock}
    `;
    return rows.map(toRow);
  }

  async findSalesByIds(
    saleIds: readonly string[],
    options: { lock: boolean },
  ): Promise<CollectionSaleRow[]> {
    if (saleIds.length === 0) return [];
    const tenantId = this.tenantPrisma.getTenantId();
    const lock = options.lock ? Prisma.sql`FOR UPDATE` : Prisma.empty;
    const rows = await this.tenantPrisma.getClient().$queryRaw<RawSaleRow[]>`
      SELECT ${SALE_COLUMNS}
      FROM sales
      WHERE "tenantId" = ${tenantId}
        AND id = ANY(${[...saleIds]}::text[])
      ORDER BY id
      ${lock}
    `;
    return rows.map(toRow);
  }

  async sumOpenDebt(customerId: string): Promise<number> {
    const tenantId = this.tenantPrisma.getTenantId();
    const aggregate = await this.tenantPrisma.getClient().sale.aggregate({
      where: { tenantId, customerId, status: 'CONFIRMED' },
      _sum: { openDebtCents: true },
    });
    return aggregate._sum.openDebtCents ?? 0;
  }

  async insertCollection(input: {
    id: string;
    customerId: string;
    actorUserId: string;
    cashSessionId: string;
    tenderedCents: number;
    appliedCents: number;
    changeDueCents: number;
    tendersJson: unknown;
  }): Promise<{ createdAt: Date }> {
    const tenantId = this.tenantPrisma.getTenantId();
    const created = await this.tenantPrisma.getClient().saleCollection.create({
      data: {
        id: input.id,
        tenantId,
        customerId: input.customerId,
        actorUserId: input.actorUserId,
        cashSessionId: input.cashSessionId,
        tenderedCents: input.tenderedCents,
        appliedCents: input.appliedCents,
        changeDueCents: input.changeDueCents,
        tendersJson: input.tendersJson as Prisma.InputJsonValue,
      },
      select: { createdAt: true },
    });
    return { createdAt: created.createdAt };
  }
}
