import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { IReceiptReviewerLookup } from '../domain/receipt-reviewer-lookup.port';

/**
 * TenantMembership is not in TENANT_SCOPED_MODELS, so `tenantId` is passed
 * explicitly: a user who belongs to two tenants is only resolved through
 * the membership (and role) of the calling tenant.
 */
@Injectable()
export class PrismaReceiptReviewerLookup implements IReceiptReviewerLookup {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async resolveReviewerEmails(userIds: string[]): Promise<string[]> {
    if (userIds.length === 0) return [];

    const rows = await this.tenantPrisma.getClient().tenantMembership.findMany({
      where: {
        userId: { in: userIds },
        tenantId: this.tenantPrisma.getTenantId(),
        user: { isActive: true },
        role: {
          permissions: {
            some: {
              permission: {
                OR: [
                  {
                    subject: 'ReceiptEvidence',
                    action: { in: ['update', 'manage'] },
                  },
                  { subject: 'all', action: 'manage' },
                ],
              },
            },
          },
        },
      },
      select: { user: { select: { email: true } } },
    });

    return Array.from(new Set(rows.map((row) => row.user.email)));
  }
}
