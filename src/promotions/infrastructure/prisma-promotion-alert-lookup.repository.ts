/**
 * ADAPTER: PrismaPromotionAlertLookupRepository — pca-3b4a.
 *
 * Implements `IPromotionAlertLookup` against the global `PrismaService`
 * (not `TenantPrismaService`) so the lookup can run OUTSIDE the HTTP CLS
 * context, exactly like `PrismaSaleCustomerEmailRepository`. The explicit
 * `tenantId` argument is the only tenant authority, so both `id` and
 * `tenantId` go into the `where` clause (defense in depth): a stale or
 * tampered promotion id can never resolve a title from another tenant.
 *
 * The projection asks for `title` ONLY. The alert email needs a label,
 * not the promotion aggregate, so no `include` or relation hydration may
 * be added here; the unit spec's projection-driven Prisma double fails
 * if the title-only `select` is widened.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { IPromotionAlertLookup } from '../domain/promotion-alert-lookup.repository';

@Injectable()
export class PrismaPromotionAlertLookupRepository implements IPromotionAlertLookup {
  constructor(private readonly prisma: PrismaService) {}

  async findTitle(input: {
    tenantId: string;
    promotionId: string;
  }): Promise<string | null> {
    if (!input.tenantId || !input.promotionId) {
      return null;
    }

    const row = await this.prisma.promotion.findFirst({
      where: { id: input.promotionId, tenantId: input.tenantId },
      select: { title: true },
    });

    return row?.title ?? null;
  }
}
