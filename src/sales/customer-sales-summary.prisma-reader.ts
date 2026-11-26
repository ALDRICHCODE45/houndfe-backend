/**
 * customers-listing T4 (S4, contract §6.2, §12) — PostgreSQL adapter of
 * `ICustomerSalesSummaryReader`.
 *
 * One statement: the tenant's customer row joined LATERAL to the SAME
 * fragment the listing row runs (`customerSalesMetricsSql`, called exactly
 * like `customers-listing.sql.ts` does, with `c."id"`), so the KPI strip and
 * the table can never disagree. No customer row → `null` (404 upstream).
 * Raw SQL bypasses the CLS tenant extension: `tenantId` is explicit on
 * `customers` here and on `sales` inside the fragment.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  customerSalesMetricsSql,
  type CustomerSalesMetricsRecord,
} from '../customers/listing/customer-sales-metrics.sql';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import type { ICustomerSalesSummaryReader } from './customer-sales-summary.reader';

@Injectable()
export class PrismaCustomerSalesSummaryReader implements ICustomerSalesSummaryReader {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async read(
    customerId: string,
    overdueBefore: Date,
  ): Promise<CustomerSalesMetricsRecord | null> {
    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.tenantPrisma.getTenantId();
    const metrics = customerSalesMetricsSql({
      tenantId,
      customerId: Prisma.sql`c."id"`,
      overdueBefore,
    });
    const rows = await prisma.$queryRaw<CustomerSalesMetricsRecord[]>`
      SELECT m.*
      FROM "customers" c
      LEFT JOIN LATERAL (${metrics}) m ON true
      WHERE c."id" = ${customerId} AND c."tenantId" = ${tenantId}
    `;
    return rows[0] ?? null;
  }
}
