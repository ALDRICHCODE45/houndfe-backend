import { ConflictException, ForbiddenException } from '@nestjs/common';
import { TenantsService } from './tenants.service';

describe('TenantsService', () => {
  it('super-admin creates tenant successfully', async () => {
    const repo = {
      create: jest.fn().mockResolvedValue({ id: 't1', name: 'HQ', slug: 'hq' }),
    } as any;
    const service = new TenantsService(repo, { get: jest.fn().mockReturnValue({ isSuperAdmin: true }) } as any);

    await expect(service.create({ name: 'HQ', slug: 'hq' })).resolves.toEqual(
      expect.objectContaining({ id: 't1', slug: 'hq' }),
    );
  });

  it('duplicate slug throws ConflictException', async () => {
    const repo = {
      create: jest.fn().mockRejectedValue(new ConflictException('TENANT_ALREADY_EXISTS')),
    } as any;
    const service = new TenantsService(repo, { get: jest.fn().mockReturnValue({ isSuperAdmin: true }) } as any);

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
    const service = new TenantsService(repo, { get: jest.fn().mockReturnValue({ isSuperAdmin: true }) } as any);

    await expect(service.assertTenantActive('t1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('non-super-admin throws ForbiddenException for create', async () => {
    const repo = { create: jest.fn() } as any;
    const service = new TenantsService(repo, { get: jest.fn().mockReturnValue({ isSuperAdmin: false }) } as any);

    await expect(service.create({ name: 'HQ', slug: 'hq' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
