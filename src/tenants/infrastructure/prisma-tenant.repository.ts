import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { ITenantRepository } from '../domain/tenant.repository';
import type { Tenant } from '../domain/tenant.entity';

@Injectable()
export class PrismaTenantRepository implements ITenantRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: {
    name: string;
    slug: string;
    address?: string;
    phone?: string;
  }): Promise<Tenant> {
    try {
      const created = await this.prisma.tenant.create({
        data: {
          name: data.name,
          slug: data.slug,
          address: data.address ?? null,
          phone: data.phone ?? null,
        },
      });
      return created;
    } catch (error) {
      this.handleConflict(error);
      throw error;
    }
  }

  async findById(id: string): Promise<Tenant | null> {
    return this.prisma.tenant.findUnique({ where: { id } });
  }

  async findBySlug(slug: string): Promise<Tenant | null> {
    return this.prisma.tenant.findUnique({ where: { slug } });
  }

  async findAll(includeInactive = false): Promise<Tenant[]> {
    return this.prisma.tenant.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async update(
    id: string,
    data: Partial<Pick<Tenant, 'name' | 'slug' | 'address' | 'phone' | 'isActive'>>,
  ): Promise<Tenant> {
    try {
      return await this.prisma.tenant.update({
        where: { id },
        data: {
          name: data.name,
          slug: data.slug,
          address: data.address,
          phone: data.phone,
          isActive: data.isActive,
        },
      });
    } catch (error) {
      this.handleConflict(error);
      throw error;
    }
  }

  async deactivate(id: string): Promise<void> {
    await this.prisma.tenant.update({ where: { id }, data: { isActive: false } });
  }

  private handleConflict(error: unknown): never | void {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === 'P2002'
    ) {
      throw new ConflictException('TENANT_ALREADY_EXISTS');
    }

    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code?.startsWith('P')
    ) {
      throw new InternalServerErrorException('Tenant persistence failed');
    }
  }
}
