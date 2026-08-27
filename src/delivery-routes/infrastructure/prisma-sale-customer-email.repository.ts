/**
 * ADAPTER: PrismaSaleCustomerEmailRepository — delivery-routes / WU3.
 *
 * Concrete implementation of `ISaleCustomerEmailLookup`. Uses the
 * global `PrismaService` (not `TenantPrismaService`) so the port can
 * be invoked OUTSIDE the HTTP CLS context — the Inngest handler's
 * `tenantRunner.runWithTenant(tenantId, ...)` opens a fresh scope
 * inside the step callback, so we trust the explicit `tenantId` arg
 * and use `where: { id: saleId, tenantId }` for defense in depth.
 *
 * Tenant scoping — CRITICAL.
 *
 * The lookup reads `sale.customer.email`. A cross-tenant `saleId`
 * (one belonging to a different tenant) MUST resolve to `null`; the
 * Inngest function then logs `skipped: no-email` rather than
 * dispatching to a foreign address. Both `id` AND `tenantId` go into
 * the `where` clause so a tampered saleId can't slip past.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type {
  ISaleCustomerEmailLookup,
} from '../domain/ports/sale-customer-email.port';

@Injectable()
export class PrismaSaleCustomerEmailRepository
  implements ISaleCustomerEmailLookup
{
  constructor(private readonly prisma: PrismaService) {}

  async findEmailBySaleId(input: {
    tenantId: string;
    saleId: string;
  }): Promise<string | null> {
    if (!input.tenantId || !input.saleId) {
      return null;
    }
    const row = await this.prisma.sale.findFirst({
      where: { id: input.saleId, tenantId: input.tenantId },
      select: {
        customer: {
          select: { email: true },
        },
      },
    });
    if (!row || !row.customer) {
      return null;
    }
    const email = row.customer.email;
    if (typeof email !== 'string') {
      return null;
    }
    const trimmed = email.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
}
