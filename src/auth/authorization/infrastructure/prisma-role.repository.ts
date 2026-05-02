/**
 * ADAPTER: PrismaRoleRepository
 *
 * Concrete implementation of IRoleRepository using Prisma.
 *
 * Translates between domain entities and database records.
 * Contains mappers that convert DB rows ↔ domain objects.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { Role } from '../domain/role.entity';
import type {
  IRoleRepository,
  RoleWithUserCount,
} from '../domain/role.repository';
import type { PermissionDefinition } from '../domain/permission';

@Injectable()
export class PrismaRoleRepository implements IRoleRepository {
  constructor(private readonly prisma: PrismaService) {}

  async save(role: Role): Promise<Role> {
    const data = role.toPersistence();
    const saved = await this.prisma.role.upsert({
      where: { id: data.id },
      update: {
        name: data.name,
        description: data.description,
        isSystem: data.isSystem,
        updatedAt: data.updatedAt,
      },
      create: data,
      include: {
        permissions: {
          include: {
            permission: true,
          },
        },
      },
    });
    return this.toDomain(saved);
  }

  async findById(id: string): Promise<Role | null> {
    const data = await this.prisma.role.findUnique({
      where: { id },
      include: {
        permissions: {
          include: {
            permission: true,
          },
        },
      },
    });
    return data ? this.toDomain(data) : null;
  }

  async findByName(name: string): Promise<Role | null> {
    const data = await this.prisma.role.findFirst({
      where: { name },
      include: {
        permissions: {
          include: {
            permission: true,
          },
        },
      },
    });
    return data ? this.toDomain(data) : null;
  }

  async findAll(): Promise<Role[]> {
    const data = await this.prisma.role.findMany({
      include: {
        permissions: {
          include: {
            permission: true,
          },
        },
      },
    });
    return data.map((r) => this.toDomain(r));
  }

  async delete(id: string): Promise<void> {
    await this.prisma.role.delete({ where: { id } });
  }

  async assignPermissions(
    roleId: string,
    permissionIds: string[],
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.rolePermission.deleteMany({ where: { roleId } }),
      this.prisma.rolePermission.createMany({
        data: permissionIds.map((permissionId) => ({
          id: crypto.randomUUID(),
          roleId,
          permissionId,
        })),
      }),
    ]);
  }

  async findAllWithCounts(): Promise<RoleWithUserCount[]> {
    const data = await this.prisma.role.findMany({
      include: {
        permissions: { include: { permission: true } },
        _count: { select: { tenantMemberships: true } },
      },
    });
    return data.map((r) => ({
      role: this.toDomain(r),
      userCount: r._count.tenantMemberships,
    }));
  }

  private toDomain(data: {
    id: string;
    name: string;
    description: string | null;
    isSystem: boolean;
    createdAt: Date;
    updatedAt: Date;
    permissions: Array<{
      permission: {
        id: string;
        subject: string;
        action: string;
        description: string | null;
        createdAt: Date;
      };
    }>;
  }): Role {
    const permissions: PermissionDefinition[] = data.permissions.map((rp) => ({
      subject: rp.permission.subject as PermissionDefinition['subject'],
      action: rp.permission.action as PermissionDefinition['action'],
      description: rp.permission.description ?? '',
    }));

    return Role.fromPersistence({
      id: data.id,
      name: data.name,
      description: data.description,
      isSystem: data.isSystem,
      permissions,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    });
  }
}
