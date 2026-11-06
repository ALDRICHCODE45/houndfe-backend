/**
 * shipping-zones / T1 (S3) — ADAPTER: recipients holding a validating grant
 * through a role membership in the CLS tenant (see the port for the rule).
 */
import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { IDeliveryZoneValidatorLookup } from '../domain/delivery-zone-validator-lookup';

const VALIDATING_GRANTS = [
  { subject: 'DeliveryZone', action: 'validate' },
  { subject: 'DeliveryZone', action: 'manage' },
  { subject: 'all', action: 'manage' },
];

@Injectable()
export class PrismaDeliveryZoneValidatorLookup implements IDeliveryZoneValidatorLookup {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async filterValidators(userIds: string[]): Promise<string[]> {
    if (userIds.length === 0) {
      return [];
    }
    const tenantId = this.tenantPrisma.getTenantId();
    const memberships = await this.tenantPrisma
      .getClient()
      .tenantMembership.findMany({
        where: {
          tenantId,
          userId: { in: userIds },
          user: { isActive: true },
          role: {
            permissions: {
              some: { permission: { OR: VALIDATING_GRANTS } },
            },
          },
        },
        select: { userId: true },
      });
    return [...new Set(memberships.map((membership) => membership.userId))];
  }
}
