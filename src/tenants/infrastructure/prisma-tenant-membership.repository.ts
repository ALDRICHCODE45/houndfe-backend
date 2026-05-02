import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { ITenantMembershipRepository } from '../domain/tenant-membership.repository';
import type { TenantMembership } from '../domain/tenant-membership.entity';

@Injectable()
export class PrismaTenantMembershipRepository
  implements ITenantMembershipRepository
{
  constructor(private readonly prisma: PrismaService) {}

  async create(data: {
    userId: string;
    tenantId: string;
    roleId: string;
  }): Promise<TenantMembership> {
    const role = await this.prisma.role.findUnique({
      where: { id: data.roleId },
      select: { tenantId: true },
    });

    if (!role || role.tenantId !== data.tenantId) {
      throw new BadRequestException('ROLE_TENANT_MISMATCH');
    }

    try {
      return await this.prisma.tenantMembership.create({ data });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: string }).code === 'P2002'
      ) {
        throw new ConflictException('TENANT_MEMBERSHIP_EXISTS');
      }
      throw error;
    }
  }

  async findByTenant(tenantId: string): Promise<TenantMembership[]> {
    return this.prisma.tenantMembership.findMany({ where: { tenantId } });
  }

  async findByUserAndTenant(
    userId: string,
    tenantId: string,
  ): Promise<TenantMembership[]> {
    return this.prisma.tenantMembership.findMany({ where: { userId, tenantId } });
  }

  async findByUserId(userId: string): Promise<TenantMembership[]> {
    return this.prisma.tenantMembership.findMany({ where: { userId } });
  }

  async update(id: string, data: { roleId: string }): Promise<TenantMembership> {
    const current = await this.prisma.tenantMembership.findUnique({
      where: { id },
      select: { tenantId: true },
    });

    if (!current) {
      throw new BadRequestException('TENANT_MEMBERSHIP_NOT_FOUND');
    }

    const role = await this.prisma.role.findUnique({
      where: { id: data.roleId },
      select: { tenantId: true },
    });

    if (!role || role.tenantId !== current.tenantId) {
      throw new BadRequestException('ROLE_TENANT_MISMATCH');
    }

    return this.prisma.tenantMembership.update({ where: { id }, data });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.tenantMembership.delete({ where: { id } });
  }
}
