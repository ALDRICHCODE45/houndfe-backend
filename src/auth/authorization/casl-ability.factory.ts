/**
 * CaslAbilityFactory - Creates CASL abilities for users.
 *
 * Injectable service that builds MongoAbility instances from user permissions.
 *
 * RESPONSIBILITIES:
 * - Query user → roles → permissions from database
 * - Flatten permissions from all roles
 * - Build CASL ability using AbilityBuilder
 * - Handle 'manage' on 'all' for super admin
 *
 * PERFORMANCE: Single Prisma query with nested includes per request.
 * Lazy loading (no caching yet — deferred for later optimization).
 */

import { Injectable } from '@nestjs/common';
import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { AppAbility, AppActions, AppSubjects } from './domain/permission';

@Injectable()
export class CaslAbilityFactory {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creates a CASL ability instance for a specific user.
   *
   * @param userId - The user's ID
   * @returns AppAbility instance with all user permissions
   */
  async createForUser(userId: string): Promise<AppAbility> {
    const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);

    // Single query with nested includes: user → roles → role → permissions → permission
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        roles: {
          include: {
            role: {
              include: {
                permissions: {
                  include: {
                    permission: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!user) {
      // User not found → return empty ability (no permissions)
      return build();
    }

    // Flatten all permissions from all roles
    const permissions = user.roles.flatMap((userRole) =>
      userRole.role.permissions.map((rolePermission) => ({
        action: rolePermission.permission.action as AppActions,
        subject: rolePermission.permission.subject as AppSubjects,
      })),
    );

    // Build ability rules
    for (const permission of permissions) {
      can(permission.action, permission.subject);
    }

    return build();
  }
}
