import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { TenantClsStore } from '../tenant/tenant-cls-store.interface';
import { createTenantScopedPrisma } from './tenant-prisma.factory';
import { PrismaService } from './prisma.service';

@Injectable()
export class TenantPrismaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService<TenantClsStore>,
  ) {}

  getClient() {
    return createTenantScopedPrisma(this.prisma, this.cls);
  }

  getTenantId(): string {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) {
      throw new Error('Tenant context required');
    }
    return tenantId;
  }
}
