/**
 * ADAPTER: PrismaSaleDeliveryStopProvenanceRepository — delivery-routes /
 * DTE-4a.proof.
 *
 * Concrete implementation of `ISaleDeliveryStopProvenance`. Uses the
 * global `PrismaService` (not `TenantPrismaService`) so the port can be
 * invoked OUTSIDE the HTTP CLS context — the Inngest handler's
 * `tenantRunner.runWithTenant(tenantId, ...)` opens a fresh scope inside
 * the step callback, so we trust the explicit `tenantId` argument and
 * keep it in the `where` clause for defense in depth.
 *
 * The entire proof is ONE `findFirst` whose `where` carries the full
 * conjunction; Prisma is the only place that can evaluate row-level
 * predicates, so the adapter maps `row !== null` to `true` and never
 * re-derives eligibility in memory. A blank identity field short-circuits
 * to `false` before any read.
 *
 * Query shape (reasoning in the port):
 *   where: {
 *     id: stopId, tenantId, routeId, saleId,
 *     status: 'COMPLETED',
 *     checkedInAt: { not: null }, completedAt: { not: null },
 *     route: { tenantId },
 *   }
 *   select: { id: true }
 *
 * `route.status` and `Sale.channel` are deliberately absent: a route can
 * be cancelled after a completed stop, and channel is not provenance.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { ISaleDeliveryStopProvenance } from '../domain/ports/sale-delivery-stop-provenance.port';

@Injectable()
export class PrismaSaleDeliveryStopProvenanceRepository implements ISaleDeliveryStopProvenance {
  constructor(private readonly prisma: PrismaService) {}

  async hasCompletedRouteStop(input: {
    tenantId: string;
    routeId: string;
    stopId: string;
    saleId: string;
  }): Promise<boolean> {
    // Blank means EMPTY OR WHITESPACE-ONLY: a padded event id is a
    // malformed identity, not a valid one. The guard trims only to
    // decide, and a non-blank id reaches Prisma exactly as supplied (no
    // silent normalization that could diverge from the guard).
    if (
      !input.tenantId.trim() ||
      !input.routeId.trim() ||
      !input.stopId.trim() ||
      !input.saleId.trim()
    ) {
      return false;
    }

    const row = await this.prisma.deliveryRouteStop.findFirst({
      where: {
        id: input.stopId,
        tenantId: input.tenantId,
        routeId: input.routeId,
        saleId: input.saleId,
        status: 'COMPLETED',
        checkedInAt: { not: null },
        completedAt: { not: null },
        route: { tenantId: input.tenantId },
      },
      select: { id: true },
    });

    return row !== null;
  }
}
