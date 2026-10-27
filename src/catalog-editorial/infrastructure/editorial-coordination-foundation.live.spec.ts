import { AsyncLocalStorage } from 'node:async_hooks';
import type { CatalogEditorialCore } from '../application/catalog-editorial-core';
import type { EditorialDocument } from '../domain/document';
import type { ProductsService } from '../../products/products.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { loadEditorialPostgresClient } from './editorial-coordination-postgres-binding';
import {
  readEditorialRows,
  readVariantMembership,
  readVariantPrices,
  seedEditorialPostgres,
  type EditorialFixture,
} from './editorial-coordination-postgres-fixture';

function unused<T>(label: string): T {
  // Test-only collaborator: every property access fails, never a silent no-op.
  return new Proxy(
    {},
    {
      get() {
        throw new Error(`Unexpected smoke collaborator: ${label}`);
      },
    },
  ) as T;
}
const context = ({ ids }: EditorialFixture) => ({
  actorId: ids.userId,
  tenantId: ids.tenantId,
  productId: ids.productId,
});
function document(
  seed: EditorialFixture,
  optionCode: string,
): EditorialDocument {
  return {
    commercialTitle: null,
    description: null,
    mediaRefs: [seed.ids.assetId],
    familyCode: seed.ids.familyId,
    values: [
      {
        code: seed.ids.definitionId,
        owner: 'product',
        variantId: null,
        type: 'single',
        value: optionCode,
      },
    ],
  };
}

describe('live editorial coordination foundation', () => {
  let client: Awaited<ReturnType<typeof loadEditorialPostgresClient>>;
  let editorial: CatalogEditorialCore;
  let freshSeed: () => Promise<EditorialFixture>;
  let readProduct: (
    seed: EditorialFixture,
  ) => ReturnType<ProductsService['findOne']>;

  beforeAll(async () => {
    // No skip/fallback: absent binding rejects BEFORE application imports.
    client = await loadEditorialPostgresClient();
    const { PrismaCatalogEditorial } =
      await import('./prisma-catalog-editorial');
    const { PrismaEditorialAuthority } =
      await import('./prisma-editorial-authority');
    const { createCoordinatedEditorialWriteAuthority } =
      await import('./prisma-coordinated-editorial-authority');
    const { ProductsService } = await import('../../products/products.service');
    const { PrismaProductRepository } =
      await import('../../products/infrastructure/prisma-product.repository');
    const { TenantPrismaService } =
      await import('../../shared/prisma/tenant-prisma.service');
    const { ClsService } = await import('nestjs-cls');
    const { randomUUID } = await import('node:crypto');
    editorial = new PrismaCatalogEditorial(
      client,
      new PrismaEditorialAuthority(client),
      undefined,
      undefined,
      createCoordinatedEditorialWriteAuthority,
    );
    const cls = new ClsService<TenantClsStore>(
      new AsyncLocalStorage<TenantClsStore>(),
    );
    // Only inherited PrismaClient APIs are used; no Nest lifecycle/bootstrap.
    const tenant = new TenantPrismaService(
      client as ConstructorParameters<typeof TenantPrismaService>[0],
      cls,
    );
    const repository = new PrismaProductRepository(
      tenant,
      unused('OutboxWriterService'),
      unused('IStockAlertStateRepository'),
    );
    const products = new ProductsService(
      repository,
      unused('ProductsService root PrismaService'),
      unused('FilesService'),
      tenant,
      unused('SatCatalogService'),
    );
    freshSeed = () => seedEditorialPostgres(client, randomUUID());
    readProduct = (seed) =>
      cls.runWith(
        {
          tenantId: seed.ids.tenantId,
          userId: seed.ids.userId,
          isSuperAdmin: false,
        },
        () => products.findOne(seed.ids.productId),
      );
  });
  afterAll(async () => {
    await client?.$disconnect();
  });

  it('reads canonical seeded membership, flags and Variant prices', async () => {
    const seed = await freshSeed();
    const membership = await readVariantMembership(
      client,
      seed.ids.tenantId,
      seed.ids.productId,
    );
    expect(membership.products).toHaveLength(1);
    expect(membership.products[0]).toMatchObject({
      id: seed.ids.productId,
      hasVariants: true,
      useStock: true,
      useLotsAndExpirations: false,
      quantity: 0,
      minQuantity: 0,
    });
    expect(membership.variants).toEqual([
      { id: seed.ids.variantId, quantity: 10, minQuantity: 0 },
    ]);
    await expect(
      readVariantPrices(client, seed.ids.tenantId, seed.ids.variantId),
    ).resolves.toEqual([
      {
        id: seed.ids.variantPriceId,
        priceListId: seed.ids.priceListId,
        priceCents: 1234,
      },
    ]);
  });
  it('persists selected asset/active-option draft and its create receipt through actual composition', async () => {
    const seed = await freshSeed();
    const scope = context(seed);
    const candidate = document(seed, seed.values.activeOptionCode);
    const idempotencyKey = 'foundation-create';
    const result = await editorial.create(scope, {
      expectedCycle: null,
      idempotencyKey,
      document: candidate,
    });
    expect(result).toEqual({
      cycle: 1,
      draft: { revision: 1, basePublishedRevision: null, document: candidate },
      published: null,
    });
    const rows = await readEditorialRows(
      client,
      scope.tenantId,
      scope.productId,
    );
    expect(rows.states).toHaveLength(1);
    expect(rows.states[0]).toMatchObject({
      tenantId: scope.tenantId,
      productId: scope.productId,
      cycle: 1,
      draftRevision: 1,
      basePublishedRevision: null,
      draftDocument: candidate,
      publishedRevision: null,
      publishedDocument: null,
    });
    expect(rows.createReceipts).toHaveLength(1);
    expect(rows.createReceipts[0]).toMatchObject({
      ...scope,
      idempotencyKey,
      request: { expectedCycle: null, document: candidate },
      result,
    });
    expect(rows.saveReceipts).toEqual([]);
  });
  it('rejects a newly assigned archived option without persisted editorial effects', async () => {
    const seed = await freshSeed();
    const scope = context(seed);
    await expect(
      editorial.create(scope, {
        expectedCycle: null,
        idempotencyKey: 'foundation-archived',
        document: document(seed, seed.values.archivedOptionCode),
      }),
    ).rejects.toEqual(new Error('MALFORMED'));
    await expect(
      readEditorialRows(client, scope.tenantId, scope.productId),
    ).resolves.toEqual({
      states: [],
      createReceipts: [],
      saveReceipts: [],
    });
  });
  it('reads the seeded Product through actual repository, tenant Prisma and CLS', async () => {
    const seed = await freshSeed();
    const product = await readProduct(seed);
    expect(product.id).toBe(seed.ids.productId);
    expect(product.sku).toBe(seed.values.sku);
    expect(product.variants).toHaveLength(1);
    expect(product.variants[0].id).toBe(seed.ids.variantId);
    expect(product.variants[0].variantPrices[0].priceCents).toBe(1234);
  });
});
