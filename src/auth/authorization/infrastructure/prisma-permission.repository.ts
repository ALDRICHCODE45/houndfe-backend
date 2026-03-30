/**
 * ADAPTER: PrismaPermissionRepository
 *
 * Concrete implementation of IPermissionRepository using Prisma.
 *
 * Read-only adapter for querying permissions from the database.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import type {
  IPermissionRepository,
  PermissionRecord,
} from '../domain/permission.repository';

@Injectable()
export class PrismaPermissionRepository implements IPermissionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(): Promise<PermissionRecord[]> {
    return this.prisma.permission.findMany({
      orderBy: [{ subject: 'asc' }, { action: 'asc' }],
    });
  }

  async findByIds(ids: string[]): Promise<PermissionRecord[]> {
    return this.prisma.permission.findMany({
      where: { id: { in: ids } },
    });
  }
}
