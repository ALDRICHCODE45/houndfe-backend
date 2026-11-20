import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { allocateBackorderFolio } from './backorder-folio.allocator';

type TenantClient = ReturnType<TenantPrismaService['getClient']>;

describe('allocateBackorderFolio', () => {
  it('upserts the tenant counter atomically and formats BO-000001', async () => {
    const upsert = jest.fn().mockResolvedValue({ lastNumber: 1 });
    const tx = { backorderFolioCounter: { upsert } } as unknown as TenantClient;
    await expect(allocateBackorderFolio(tx, 'tenant-1')).resolves.toBe(
      'BO-000001',
    );
    expect(upsert).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1' },
      create: { tenantId: 'tenant-1', lastNumber: 1 },
      update: { lastNumber: { increment: 1 } },
    });
  });

  it('formats whatever number the counter returned', async () => {
    const tx = {
      backorderFolioCounter: {
        upsert: jest.fn().mockResolvedValue({ lastNumber: 124 }),
      },
    } as unknown as TenantClient;
    await expect(allocateBackorderFolio(tx, 'tenant-1')).resolves.toBe(
      'BO-000124',
    );
  });
});
