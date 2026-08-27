import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import { AssignableUserDto } from './dto/assignable-user.dto';

/** One tenant membership with its role's raw permission rows. */
interface DriverMembership {
  role: {
    permissions: Array<{
      permission: { subject: string; action: string };
    }>;
  };
}

/**
 * Driver-pure check (delivery-routes design ADR-5 discriminator).
 *
 * A user is an assignable driver when at least one of their tenant roles
 * grants `read` + `update` on `DeliveryRoute`, and NO tenant role grants
 * `create` or `delete` on it (those mark a route-manager). Roles granting
 * `manage` on `all` are excluded too — they can create/delete via the
 * wildcard permission.
 */
function isAssignableDriver(memberships: DriverMembership[]): boolean {
  let hasReadUpdate = false;

  for (const membership of memberships) {
    const actions = new Set(
      membership.role.permissions.map(
        (p) => `${p.permission.action}:${p.permission.subject}`,
      ),
    );

    if (
      actions.has('create:DeliveryRoute') ||
      actions.has('delete:DeliveryRoute') ||
      actions.has('manage:all')
    ) {
      return false;
    }
    if (
      actions.has('read:DeliveryRoute') &&
      actions.has('update:DeliveryRoute')
    ) {
      hasReadUpdate = true;
    }
  }

  return hasReadUpdate;
}

@Injectable()
export class UsersService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async findAssignable(): Promise<AssignableUserDto[]> {
    const tenantId = this.tenantPrisma.getTenantId();

    return this.tenantPrisma.getClient().user.findMany({
      where: {
        isActive: true,
        tenantMemberships: {
          some: { tenantId },
        },
      },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * Users assignable as `driverUserId` on a delivery route (delivery-routes).
   *
   * The backend cannot use the CASL ability for this filter: driver-only
   * abilities carry the conditional rules `can('read', 'DeliveryRoute',
   * { driverUserId })` (ADR-5), and `ability.can(action, subject)` without a
   * tagged instance fails those conditions — a driver-only caller would look
   * like it can do nothing. So we inspect the raw role permissions, the same
   * source `CaslAbilityFactory.queryUserPermissions` reads.
   */
  async findAssignableDrivers(): Promise<AssignableUserDto[]> {
    const tenantId = this.tenantPrisma.getTenantId();

    const users = await this.tenantPrisma.getClient().user.findMany({
      where: {
        isActive: true,
        tenantMemberships: {
          some: { tenantId },
        },
      },
      select: {
        id: true,
        name: true,
        tenantMemberships: {
          where: { tenantId },
          select: {
            role: {
              select: {
                permissions: {
                  select: {
                    permission: { select: { subject: true, action: true } },
                  },
                },
              },
            },
          },
        },
      },
    });

    return users
      .filter((user) => isAssignableDriver(user.tenantMemberships))
      .map(({ id, name }) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}
