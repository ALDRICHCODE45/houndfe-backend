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
 * - Expose effective permissions for frontend consumption
 *
 * PERFORMANCE: Single Prisma query with nested includes per request.
 * Lazy loading (no caching yet — deferred for later optimization).
 */

import { Injectable } from '@nestjs/common';
import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { AppAbility, AppActions, AppSubjects } from './domain/permission';

/** Effective permission for a user — deduplicated and sorted. */
export interface EffectivePermission {
  subject: AppSubjects;
  action: AppActions;
}

export interface AbilityContext {
  tenantId: string | null;
  isSuperAdmin: boolean;
}

@Injectable()
export class CaslAbilityFactory {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creates a CASL ability instance for a specific user.
   *
   * @param userId - The user's ID
   * @returns AppAbility instance with all user permissions
   */
  async createForUser(userId: string, context: AbilityContext): Promise<AppAbility> {
    const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);

    if (context.isSuperAdmin && context.tenantId === null) {
      can('manage', 'all');
      return build();
    }

    const permissions = await this.queryUserPermissions(userId, context.tenantId);

    if (!permissions) {
      // User not found → return empty ability (no permissions)
      return build();
    }

    for (const permission of permissions) {
      can(permission.action, permission.subject);
    }

    return build();
  }

  /**
   * Returns the effective permissions for a user — deduplicated and deterministically sorted.
   *
   * Reuses the same user → roles → permissions query as createForUser().
   * Used by GET /auth/me/permissions for frontend consumption.
   *
   * @param userId - The user's ID
   * @returns Deduplicated permissions sorted by action:subject, or null if user not found
   */
  async getEffectivePermissions(
    userId: string,
    context: AbilityContext,
  ): Promise<EffectivePermission[] | null> {
    if (context.isSuperAdmin && context.tenantId === null) {
      return [{ action: 'manage', subject: 'all' }];
    }

    const raw = await this.queryUserPermissions(userId, context.tenantId);

    // null means user was not found (preserve distinction for error handling upstream)
    if (raw === null) return null;

    // Deduplicate using Set with "action:subject" key
    const seen = new Set<string>();
    const unique: EffectivePermission[] = [];

    for (const perm of raw) {
      const key = `${perm.action}:${perm.subject}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push({ subject: perm.subject, action: perm.action });
      }
    }

    // Deterministic sort: action ASC, then subject ASC
    unique.sort((a, b) => {
      const actionCmp = a.action.localeCompare(b.action);
      return actionCmp !== 0 ? actionCmp : a.subject.localeCompare(b.subject);
    });

    return unique;
  }

  /**
   * Queries all permissions for a user via roles (single Prisma query).
   *
   * @returns Flattened permission array, or null if user not found
   */
  private async queryUserPermissions(
    userId: string,
    tenantId: string | null,
  ): Promise<EffectivePermission[] | null> {
    if (!tenantId) return [];

    const membership = await this.prisma.tenantMembership.findFirst({
      where: { userId, tenantId },
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
    });

    if (!membership) return [];

    return membership.role.permissions.map((rolePermission) => ({
        action: rolePermission.permission.action as AppActions,
        subject: rolePermission.permission.subject as AppSubjects,
      }));
  }
}
