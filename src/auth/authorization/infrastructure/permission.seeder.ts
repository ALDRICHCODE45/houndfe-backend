/**
 * PermissionSeeder - Seeds permissions and Super Admin role on application bootstrap.
 *
 * Injectable service that implements OnApplicationBootstrap lifecycle hook.
 * Runs automatically when the app starts.
 *
 * RESPONSIBILITIES:
 * - Upsert ALL permissions from PERMISSION_REGISTRY into database
 * - Create "Super Admin" role (isSystem: true) if not exists
 * - Link 'manage' on 'all' permission to Super Admin role
 *
 * IDEMPOTENT: Safe to run on every app restart.
 * Uses upsert operations to avoid duplicates.
 *
 * WHY OnApplicationBootstrap: Ensures database has required permissions
 * before any authorization checks happen.
 */

import { Injectable, OnApplicationBootstrap, Logger } from '@nestjs/common';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { PERMISSION_REGISTRY } from '../domain/permission';

@Injectable()
export class PermissionSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(PermissionSeeder.name);

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    this.logger.log('Seeding permissions and Super Admin role...');

    try {
      // 1. Upsert all permissions from registry
      const permissionPromises = PERMISSION_REGISTRY.map((perm) =>
        this.prisma.permission.upsert({
          where: {
            subject_action: {
              subject: perm.subject,
              action: perm.action,
            },
          },
          update: {
            description: perm.description,
          },
          create: {
            subject: perm.subject,
            action: perm.action,
            description: perm.description,
          },
        }),
      );

      const permissions = await Promise.all(permissionPromises);
      this.logger.log(`✓ Seeded ${permissions.length} permissions`);

      // 2. Upsert Super Admin role
      const existingSuperAdminRole = await this.prisma.role.findFirst({
        where: { name: 'Super Admin', tenantId: null },
      });
      const superAdminRole = existingSuperAdminRole
        ? await this.prisma.role.update({
            where: { id: existingSuperAdminRole.id },
            data: {
              description: 'Full system access',
              isSystem: true,
            },
          })
        : await this.prisma.role.create({
            data: {
              name: 'Super Admin',
              description: 'Full system access',
              isSystem: true,
            },
          });
      this.logger.log(`✓ Super Admin role: ${superAdminRole.id}`);

      // 3. Find 'manage' on 'all' permission
      const manageAllPermission = permissions.find(
        (p) => p.subject === 'all' && p.action === 'manage',
      );

      if (!manageAllPermission) {
        this.logger.error(
          'Missing "manage:all" permission in registry — cannot assign to Super Admin',
        );
        return;
      }

      // 4. Link 'manage:all' permission to Super Admin role (idempotent)
      await this.prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: superAdminRole.id,
            permissionId: manageAllPermission.id,
          },
        },
        update: {},
        create: {
          roleId: superAdminRole.id,
          permissionId: manageAllPermission.id,
        },
      });
      this.logger.log(`✓ Linked "manage:all" permission to Super Admin role`);

      this.logger.log('✓ Permission seeding completed successfully');
    } catch (error) {
      this.logger.error('Failed to seed permissions', error);
      throw error;
    }
  }
}
