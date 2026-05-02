import { PrismaOrderRepository } from './prisma-order.repository';
import { Order } from '../domain/order.entity';

function makeTenantPrismaMock() {
  const client = {
    order: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
    orderItem: {
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
  } as any;

  return {
    getClient: jest.fn().mockReturnValue(client),
    getTenantId: jest.fn().mockReturnValue('tenant-1'),
    client,
  };
}

describe('PrismaOrderRepository tenant scoping', () => {
  it('uses TenantPrismaService client for reads', async () => {
    const tenantPrisma = makeTenantPrismaMock();
    tenantPrisma.client.order.findUnique.mockResolvedValue(null);

    const repo = new PrismaOrderRepository(tenantPrisma as any);
    await repo.findById('missing-order');

    expect(tenantPrisma.getClient).toHaveBeenCalled();
  });

  it('creates orders without requiring tenantId in payload', async () => {
    const tenantPrisma = makeTenantPrismaMock();
    const order = Order.create('order-1', 'Customer One');

    tenantPrisma.client.order.upsert.mockResolvedValue({ id: 'order-1' });
    tenantPrisma.client.orderItem.deleteMany.mockResolvedValue({ count: 0 });
    tenantPrisma.client.order.findUnique.mockResolvedValue({
      id: 'order-1',
      customerName: 'Customer One',
      status: 'DRAFT',
      createdAt: new Date(),
      completedAt: null,
      items: [],
    });

    const repo = new PrismaOrderRepository(tenantPrisma as any);
    await repo.save(order);

    expect(tenantPrisma.client.order.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ tenantId: 'tenant-1' }),
      }),
    );
  });
});
