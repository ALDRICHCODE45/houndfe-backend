/**
 * ADAPTER: PrismaUserEmailLookupRepository.
 *
 * Slice F.2 of `low-stock-alerts`. Prisma-backed implementation
 * of `IUserEmailLookup`. The query joins
 * `tenant_memberships → users`, filtered by the calling tenant's
 * CLS scope (auto-injected by `TenantPrismaService.getClient()` —
 * see `tenant-prisma.service.ts:53`) and `users.isActive=true`.
 *
 * Cross-tenant defense. The CLS-seeded tenant scope ensures we
 * NEVER read a `users` row whose `tenantMemberships` don't include
 * the calling tenant. Even if a malicious caller wrote
 * `NotificationRecipient.userId` pointing at a global user who
 * happens to belong to a DIFFERENT tenant, this query returns
 * zero rows — the email is filtered out, the recipient list is
 * the empty intersection.
 *
 * `User` is a GLOBAL identity model (no `tenantId` column); the
 * tenant join is via `TenantMembership` (not in
 * `TENANT_SCOPED_MODELS` — it's the join table itself). This
 * mirrors the membership diff in `notification-config.service.ts:95`
 * idiom.
 */
import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { IUserEmailLookup } from '../domain/user-email-lookup.repository';

@Injectable()
export class PrismaUserEmailLookupRepository implements IUserEmailLookup {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async resolveEmailsByUserIds(userIds: string[]): Promise<string[]> {
    if (userIds.length === 0) {
      return [];
    }

    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.tenantPrisma.getTenantId();

    const rows = await prisma.tenantMembership.findMany({
      where: {
        userId: { in: userIds },
        tenantId, // explicit because TenantMembership is NOT in TENANT_SCOPED_MODELS
        user: { isActive: true },
      },
      select: {
        user: {
          select: { email: true },
        },
      },
    });

    const seen = new Set<string>();
    const out: string[] = [];
    for (const row of rows) {
      const email = row.user.email;
      if (seen.has(email)) continue;
      seen.add(email);
      out.push(email);
    }
    return out;
  }
}
