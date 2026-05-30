import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PublicTenantGuard } from './public-tenant.guard';
import { PrismaService } from '../../../shared/prisma/prisma.service';

describe('PublicTenantGuard', () => {
  let guard: PublicTenantGuard;
  let prisma: { tenant: { findFirst: jest.Mock } };
  let cls: { set: jest.Mock };

  beforeEach(() => {
    prisma = { tenant: { findFirst: jest.fn() } };
    cls = { set: jest.fn() };
    guard = new PublicTenantGuard(
      prisma as unknown as PrismaService,
      cls as unknown as ClsService,
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
      where: { slug: 'centro', isActive: true },
    });
    expect(cls.set).toHaveBeenCalledWith('tenantId', 'tenant-1');
    expect(cls.set).toHaveBeenCalledWith('tenantSlug', 'centro');
    expect(cls.set).toHaveBeenCalledWith('isSuperAdmin', false);
    expect(cls.set).toHaveBeenCalledWith('userId', 'public');
  });

  it('should attach publicTenant to request', async () => {
    const tenant = { id: 'tenant-1', slug: 'centro', name: 'Sucursal Centro' };
    prisma.tenant.findFirst.mockResolvedValue(tenant);

    const request = { params: { tenantSlug: 'centro' }, publicTenant: undefined as unknown };
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
});
