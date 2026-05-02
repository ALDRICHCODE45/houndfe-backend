import type { PrismaClient } from '@prisma/client';
import type { ClsService } from 'nestjs-cls';
import type { TenantClsStore } from '../tenant/tenant-cls-store.interface';
import { createTenantScopedPrisma } from './tenant-prisma.factory';

describe('createTenantScopedPrisma', () => {
  const createHarness = (store: Partial<TenantClsStore> = {}) => {
    const cls = {
      get: jest.fn((key: keyof TenantClsStore) => (store as any)[key]),
    } as unknown as ClsService<TenantClsStore>;

    const base = {
      product: {
        findFirst: jest.fn().mockResolvedValue(null),
        findFirstOrThrow: jest.fn().mockResolvedValue(null),
      },
      category: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      $extends: jest.fn(),
    } as unknown as PrismaClient;

    let allOperations: any;
    (base.$extends as jest.Mock).mockImplementation((extension) => {
      allOperations = extension.query.$allOperations;
      return { __extended: true, allOperations };
    });

    createTenantScopedPrisma(base, cls);

    return { base, allOperations };
  };

  it('injects tenantId into findMany where for scoped models', async () => {
    const { allOperations } = createHarness({
      tenantId: 'tenant-a',
      isSuperAdmin: false,
    });
    const query = jest.fn().mockResolvedValue([]);

    await allOperations({
      model: 'Product',
      operation: 'findMany',
      args: { where: { name: { contains: 'abc' } } },
      query,
    });

    expect(query).toHaveBeenCalledWith({
      where: { name: { contains: 'abc' }, tenantId: 'tenant-a' },
    });
  });

  it('injects tenantId into create data for scoped models', async () => {
    const { allOperations } = createHarness({
      tenantId: 'tenant-a',
      isSuperAdmin: false,
    });
    const query = jest.fn().mockResolvedValue({});

    await allOperations({
      model: 'Product',
      operation: 'create',
      args: { data: { name: 'Paracetamol', tenantId: 'evil-tenant' } },
      query,
    });

    expect(query).toHaveBeenCalledWith({
      data: { name: 'Paracetamol', tenantId: 'tenant-a' },
    });
  });

  it('does not filter global models', async () => {
    const { allOperations } = createHarness({
      tenantId: 'tenant-a',
      isSuperAdmin: false,
    });
    const query = jest.fn().mockResolvedValue([]);

    await allOperations({
      model: 'Category',
      operation: 'findMany',
      args: { where: { name: { contains: 'bebidas' } } },
      query,
    });

    expect(query).toHaveBeenCalledWith({
      where: { name: { contains: 'bebidas' } },
    });
  });

  it('bypasses tenant filtering for global super-admin context', async () => {
    const { allOperations } = createHarness({
      tenantId: null,
      isSuperAdmin: true,
    });
    const query = jest.fn().mockResolvedValue([]);

    await allOperations({
      model: 'Product',
      operation: 'findMany',
      args: { where: { name: { contains: 'abc' } } },
      query,
    });

    expect(query).toHaveBeenCalledWith({
      where: { name: { contains: 'abc' } },
    });
  });
});
