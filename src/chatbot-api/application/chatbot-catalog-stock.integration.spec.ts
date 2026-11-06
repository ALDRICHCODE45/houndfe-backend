/**
 * INTEGRATION SPEC: the bot catalog reports SELLABLE stock against the real
 * `nest-practice-test` DB (port 5433 — NEVER dev): units in lots whose
 * expiration calendar date is before today in the business timezone are
 * excluded from `stock.quantity` and `stock.status` on catalog search and the
 * stock check, read through the real public-catalog repository and lots table.
 *
 * Fixture: one randomized tenant per run; deleting it cascades its products
 * and lots (no TRUNCATE).
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import type { ClsService } from 'nestjs-cls';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { PrismaPublicCatalogRepository } from '../../public-catalog/infrastructure/prisma-public-catalog.repository';
import { ChatbotApiService } from './chatbot-api.service';

const SKIP_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const describeIfDb = SKIP_INTEGRATION ? describe.skip : describe;

describeIfDb('ChatbotApiService sellable catalog stock (Integration)', () => {
  let prisma: PrismaClient;
  let service: ChatbotApiService;
  let tenantId: string;
  const productName = `Bot sellable ${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    tenantId = randomUUID();
    const cls = {
      get: (key: string) => {
        if (key === 'tenantId') return tenantId;
        if (key === 'isSuperAdmin') return false;
        return undefined;
      },
    } as unknown as ClsService<TenantClsStore>;
    const tenantPrisma = new TenantPrismaService(
      prisma as unknown as ConstructorParameters<typeof TenantPrismaService>[0],
      cls,
    );
    type Ports = ConstructorParameters<typeof ChatbotApiService>;
    // SAFETY: only the catalog read, tenant client and config are exercised.
    service = new ChatbotApiService(
      new PrismaPublicCatalogRepository(
        prisma as unknown as ConstructorParameters<
          typeof PrismaPublicCatalogRepository
        >[0],
        tenantPrisma,
      ),
      {} as Ports[1],
      {} as Ports[2],
      {} as Ports[3],
      {} as Ports[4],
      tenantPrisma,
      new ConfigService({
        PROMOTIONS_BUSINESS_TIMEZONE: 'America/Mexico_City',
      }),
      {} as Ports[7],
      {} as Ports[8],
    );
    await prisma.tenant.create({
      data: {
        id: tenantId,
        name: 'Bot sellable fixture',
        slug: `bot-sellable-${tenantId.slice(0, 8)}`,
      },
    });
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.$disconnect();
  });

  async function createLotsProduct(input: {
    quantity: number;
    minQuantity: number;
    lots: Array<{ quantity: number; expirationDate: string }>;
  }): Promise<string> {
    const productId = randomUUID();
    await prisma.product.create({
      data: {
        id: productId,
        tenantId,
        name: `${productName} ${productId.slice(0, 8)}`,
        quantity: input.quantity,
        minQuantity: input.minQuantity,
        useStock: true,
      },
    });
    await prisma.lot.createMany({
      data: input.lots.map((lot, index) => ({
        tenantId,
        productId,
        lotNumber: `L-${index}`,
        quantity: lot.quantity,
        expirationDate: new Date(`${lot.expirationDate}T00:00:00.000Z`),
      })),
    });
    return productId;
  }

  it('excludes expired lots from the stock check and search quantity/status', async () => {
    const productId = await createLotsProduct({
      quantity: 10,
      minQuantity: 3,
      lots: [
        { quantity: 7, expirationDate: '2000-01-01' },
        { quantity: 2, expirationDate: '2999-12-31' },
      ],
    });

    await expect(service.checkStock(productId)).resolves.toMatchObject({
      productId,
      stock: { status: 'low_stock', quantity: 3 },
    });
    const results = await service.searchCatalog({ q: productName, limit: 50 });
    expect(results.find((item) => item.productId === productId)?.stock).toEqual(
      { status: 'low_stock', quantity: 3 },
    );
  });

  it('reports out_of_stock when only expired stock remains', async () => {
    const productId = await createLotsProduct({
      quantity: 4,
      minQuantity: 1,
      lots: [{ quantity: 4, expirationDate: '2000-01-01' }],
    });

    await expect(service.checkStock(productId)).resolves.toMatchObject({
      stock: { status: 'out_of_stock', quantity: 0 },
    });
  });
});
