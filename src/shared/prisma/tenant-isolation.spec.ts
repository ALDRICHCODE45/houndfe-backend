import { PrismaService } from './prisma.service';
import { createTenantScopedPrisma } from './tenant-prisma.factory';
import type { TenantClsStore } from '../tenant/tenant-cls-store.interface';

describe('Tenant Prisma isolation (integration)', () => {
  const ctx: TenantClsStore = {
    userId: 'test-user',
    tenantId: null,
    tenantSlug: null,
    isSuperAdmin: false,
  };

  const cls = {
    get: jest.fn((key: keyof TenantClsStore) => ctx[key]),
  };

  const tenantAId = crypto.randomUUID();
  const tenantBId = crypto.randomUUID();

  const createdProductIds: string[] = [];

  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
  });

  beforeEach(async () => {
    await prisma.tenant.createMany({
      data: [
        { id: tenantAId, name: 'Tenant A', slug: `tenant-a-${tenantAId.slice(0, 8)}` },
        { id: tenantBId, name: 'Tenant B', slug: `tenant-b-${tenantBId.slice(0, 8)}` },
      ],
      skipDuplicates: true,
    });
  });

  afterEach(async () => {
    if (createdProductIds.length) {
      await prisma.product.deleteMany({ where: { id: { in: createdProductIds } } });
      createdProductIds.length = 0;
    }

    await prisma.tenant.deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('creates in Tenant A and findMany in Tenant B returns empty', async () => {
    ctx.tenantId = tenantAId;
    ctx.isSuperAdmin = false;
    const tenantAClient = createTenantScopedPrisma(prisma, cls as any);

    const created = await tenantAClient.product.create({
      data: { name: 'Ibuprofeno' },
    });
    createdProductIds.push(created.id);

    ctx.tenantId = tenantBId;
    const tenantBClient = createTenantScopedPrisma(prisma, cls as any);
    const foundInB = await tenantBClient.product.findMany({ where: { id: created.id } });

    expect(foundInB).toHaveLength(0);
  });

  it('findUnique by id from another tenant returns null', async () => {
    ctx.tenantId = tenantAId;
    const tenantAClient = createTenantScopedPrisma(prisma, cls as any);
    const created = await tenantAClient.product.create({ data: { name: 'Aspirina' } });
    createdProductIds.push(created.id);

    ctx.tenantId = tenantBId;
    const tenantBClient = createTenantScopedPrisma(prisma, cls as any);
    const found = await tenantBClient.product.findUnique({ where: { id: created.id } });

    expect(found).toBeNull();
  });

  it('super-admin global context can read records from both tenants', async () => {
    ctx.tenantId = tenantAId;
    const tenantAClient = createTenantScopedPrisma(prisma, cls as any);
    const productA = await tenantAClient.product.create({ data: { name: 'Producto A' } });
    createdProductIds.push(productA.id);

    ctx.tenantId = tenantBId;
    const tenantBClient = createTenantScopedPrisma(prisma, cls as any);
    const productB = await tenantBClient.product.create({ data: { name: 'Producto B' } });
    createdProductIds.push(productB.id);

    ctx.tenantId = null;
    ctx.isSuperAdmin = true;
    const superAdminClient = createTenantScopedPrisma(prisma, cls as any);
    const allProducts = await superAdminClient.product.findMany({
      where: { id: { in: [productA.id, productB.id] } },
    });

    expect(allProducts).toHaveLength(2);
  });

  it('create enforces current tenantId in persisted record', async () => {
    ctx.tenantId = tenantAId;
    ctx.isSuperAdmin = false;
    const tenantClient = createTenantScopedPrisma(prisma, cls as any);

    const created = await tenantClient.product.create({
      data: { name: 'Naproxeno', tenantId: tenantBId },
    });
    createdProductIds.push(created.id);

    expect(created.tenantId).toBe(tenantAId);
  });

  it('update from Tenant B on Tenant A product is not found', async () => {
    ctx.tenantId = tenantAId;
    const tenantAClient = createTenantScopedPrisma(prisma, cls as any);
    const created = await tenantAClient.product.create({ data: { name: 'Omeprazol' } });
    createdProductIds.push(created.id);

    ctx.tenantId = tenantBId;
    const tenantBClient = createTenantScopedPrisma(prisma, cls as any);

    await expect(
      tenantBClient.product.update({
        where: { id: created.id },
        data: { name: 'Omeprazol editado' },
      }),
    ).rejects.toMatchObject({ code: 'P2025' });
  });
});
