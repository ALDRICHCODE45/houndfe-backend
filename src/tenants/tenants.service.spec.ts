import { ConflictException, ForbiddenException } from '@nestjs/common';
import { TenantsService } from './tenants.service';

describe('TenantsService', () => {
  it('super-admin creates tenant successfully', async () => {
    const repo = {
      create: jest.fn().mockResolvedValue({ id: 't1', name: 'HQ', slug: 'hq' }),
    } as any;
    const service = new TenantsService(
      repo,
      { get: jest.fn().mockReturnValue({ isSuperAdmin: true }) } as any,
      { role: { findMany: jest.fn() } } as any,
    );

    await expect(service.create({ name: 'HQ', slug: 'hq' })).resolves.toEqual(
      expect.objectContaining({ id: 't1', slug: 'hq' }),
    );
  });

  it('duplicate slug throws ConflictException', async () => {
    const repo = {
      create: jest.fn().mockRejectedValue(new ConflictException('TENANT_ALREADY_EXISTS')),
    } as any;
    const service = new TenantsService(
      repo,
      { get: jest.fn().mockReturnValue({ isSuperAdmin: true }) } as any,
      { role: { findMany: jest.fn() } } as any,
    );

    await expect(service.create({ name: 'HQ', slug: 'hq' })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('deactivated tenant on selection throws ForbiddenException', async () => {
    const repo = {
      findById: jest.fn().mockResolvedValue({
        id: 't1',
        name: 'HQ',
        slug: 'hq',
        isActive: false,
      }),
    } as any;
    const service = new TenantsService(
      repo,
      { get: jest.fn().mockReturnValue({ isSuperAdmin: true }) } as any,
      { role: { findMany: jest.fn() } } as any,
    );

    await expect(service.assertTenantActive('t1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('non-super-admin throws ForbiddenException for create', async () => {
    const repo = { create: jest.fn() } as any;
    const service = new TenantsService(
      repo,
      { get: jest.fn().mockReturnValue({ isSuperAdmin: false }) } as any,
      { role: { findMany: jest.fn() } } as any,
    );

    await expect(service.create({ name: 'HQ', slug: 'hq' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('super-admin lists roles for target tenant', async () => {
    const repo = {
      findById: jest.fn().mockResolvedValue({ id: 'tenant-b', isActive: true }),
    } as any;
    const prisma = {
      role: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'r1', name: 'Operador' },
          { id: 'r2', name: 'Supervisor' },
        ]),
      },
    } as any;

    const service = new TenantsService(
      repo,
      { get: jest.fn().mockReturnValue({ isSuperAdmin: true }) } as any,
      prisma,
    );

    await expect(service.findRoles('tenant-b')).resolves.toEqual({
      data: [
        { id: 'r1', name: 'Operador' },
        { id: 'r2', name: 'Supervisor' },
      ],
    });

    expect(prisma.role.findMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-b' },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  });

  it('non-super-admin cannot list roles for target tenant', async () => {
    const repo = { findById: jest.fn() } as any;
    const prisma = { role: { findMany: jest.fn() } } as any;
    const service = new TenantsService(
      repo,
      { get: jest.fn().mockReturnValue({ isSuperAdmin: false }) } as any,
      prisma,
    );

    await expect(service.findRoles('tenant-b')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.role.findMany).not.toHaveBeenCalled();
  });
});
