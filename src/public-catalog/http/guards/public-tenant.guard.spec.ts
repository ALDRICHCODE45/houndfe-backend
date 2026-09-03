import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PublicTenantGuard } from './public-tenant.guard';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import type { TenantClsStore } from '../../../shared/tenant/tenant-cls-store.interface';

describe('PublicTenantGuard', () => {
  let guard: PublicTenantGuard;
  let prisma: { tenant: { findFirst: jest.Mock } };
  let cls: { set: jest.Mock };

  beforeEach(() => {
    prisma = { tenant: { findFirst: jest.fn() } };
    cls = { set: jest.fn() };
    guard = new PublicTenantGuard(
      prisma as unknown as PrismaService,
      cls as unknown as ClsService<TenantClsStore>,
    );
  });

  function mockContext(params: Record<string, string> = {}): ExecutionContext {
    const request = { params, publicTenant: undefined as unknown };
    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;
  }

  it('should bypass when no tenantSlug param is present (branches endpoint)', async () => {
    const ctx = mockContext({});
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    expect(prisma.tenant.findFirst).not.toHaveBeenCalled();
  });

  it('should resolve active tenant slug and set CLS context', async () => {
    const tenant = { id: 'tenant-1', slug: 'centro', name: 'Sucursal Centro' };
    prisma.tenant.findFirst.mockResolvedValue(tenant);

    const ctx = mockContext({ tenantSlug: 'centro' });
    const result = await guard.canActivate(ctx);

    expect(result).toBe(true);
    expect(prisma.tenant.findFirst).toHaveBeenCalledWith({
      where: { slug: 'centro', isActive: true, catalogPublished: true },
    });
    expect(cls.set).toHaveBeenCalledWith('tenantId', 'tenant-1');
    expect(cls.set).toHaveBeenCalledWith('tenantSlug', 'centro');
    expect(cls.set).toHaveBeenCalledWith('isSuperAdmin', false);
    expect(cls.set).toHaveBeenCalledWith('userId', 'public');
  });

  it('should attach publicTenant to request', async () => {
    const tenant = { id: 'tenant-1', slug: 'centro', name: 'Sucursal Centro' };
    prisma.tenant.findFirst.mockResolvedValue(tenant);

    const request = {
      params: { tenantSlug: 'centro' },
      publicTenant: undefined as unknown,
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    await guard.canActivate(ctx);
    expect(request.publicTenant).toEqual({
      id: 'tenant-1',
      slug: 'centro',
      name: 'Sucursal Centro',
    });
  });

  it('should only resolve tenants that are both active and catalog-published', async () => {
    prisma.tenant.findFirst.mockResolvedValue({
      id: 'tenant-1',
      slug: 'centro',
      name: 'Sucursal Centro',
    });

    const ctx = mockContext({ tenantSlug: 'centro' });
    await guard.canActivate(ctx);

    expect(prisma.tenant.findFirst).toHaveBeenCalledWith({
      where: { slug: 'centro', isActive: true, catalogPublished: true },
    });
  });

  it('should throw exact generic Not Found for active-but-unpublished tenant and attach nothing', async () => {
    const unpublished = {
      id: 'tenant-9',
      slug: 'unpublished-shop',
      name: 'Unpublished Shop',
      isActive: true,
      catalogPublished: false,
    };
    // Mock honours every predicate the guard sends, like the real database.
    // A missing catalogPublished filter still resolves the tenant (RED proof).
    prisma.tenant.findFirst.mockImplementation(
      ({
        where,
      }: {
        where: { slug: string; isActive: boolean; catalogPublished?: boolean };
      }) =>
        Promise.resolve(
          where.slug === unpublished.slug &&
            where.isActive === unpublished.isActive &&
            (where.catalogPublished === undefined ||
              where.catalogPublished === unpublished.catalogPublished)
            ? unpublished
            : null,
        ),
    );

    const request = {
      params: { tenantSlug: 'unpublished-shop' },
      publicTenant: undefined as unknown,
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).rejects.toThrow(
      new NotFoundException('Not Found'),
    );
    expect(cls.set).not.toHaveBeenCalled();
    expect(request.publicTenant).toBeUndefined();
  });

  it('should throw generic 404 for unknown slug', async () => {
    prisma.tenant.findFirst.mockResolvedValue(null);
    const ctx = mockContext({ tenantSlug: 'nonexistent' });

    await expect(guard.canActivate(ctx)).rejects.toThrow(NotFoundException);
  });

  it('should throw generic 404 for inactive tenant (same shape as unknown)', async () => {
    // findFirst with isActive:true returns null for inactive
    prisma.tenant.findFirst.mockResolvedValue(null);
    const ctx = mockContext({ tenantSlug: 'inactive-shop' });

    await expect(guard.canActivate(ctx)).rejects.toThrow(NotFoundException);
  });

  it.each([
    ['unknown slug', 'ghost-shop', null],
    ['inactive tenant', 'inactive-shop', null],
    ['unpublished tenant', 'unpublished-shop', null],
  ])(
    '%s follows the exact generic Not Found path with no CLS or request attachment',
    async (_label, slug, dbResult) => {
      prisma.tenant.findFirst.mockResolvedValue(dbResult);
      const request = {
        params: { tenantSlug: slug },
        publicTenant: undefined as unknown,
      };
      const ctx = {
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext;

      await expect(guard.canActivate(ctx)).rejects.toThrow(
        new NotFoundException('Not Found'),
      );
      expect(cls.set).not.toHaveBeenCalled();
      expect(request.publicTenant).toBeUndefined();
    },
  );

  it('resolves a tenant that is both active and catalog-published', async () => {
    prisma.tenant.findFirst.mockResolvedValue({
      id: 'tenant-2',
      slug: 'norte',
      name: 'Sucursal Norte',
    });
    const request = {
      params: { tenantSlug: 'norte' },
      publicTenant: undefined as unknown,
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(prisma.tenant.findFirst).toHaveBeenCalledWith({
      where: { slug: 'norte', isActive: true, catalogPublished: true },
    });
    expect(cls.set).toHaveBeenCalledWith('tenantId', 'tenant-2');
    expect(request.publicTenant).toEqual({
      id: 'tenant-2',
      slug: 'norte',
      name: 'Sucursal Norte',
    });
  });
});
