/**
 * INTEGRATION SPEC: facet filters, published search and cart scope over
 * Published editorial (P4 T4: S4, plus S2/S5 for cart validation), and the
 * public rule that a Published row that is not a valid V2 document counts as
 * not published.
 *
 * Real PostgreSQL, the real publish writer and the real public use cases over
 * the real repository. The canonical production vocabulary is installed into
 * the empty test vocabulary and truncated afterwards.
 */
import { Logger, NotFoundException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { ClsService } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';
import {
  disconnectIntegrationPrisma,
  integrationPrisma,
} from '../../../test/integration/reset-db';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { readEditorialVocabulary } from '../../catalog-editorial/application/editorial-vocabulary-read';
import { createEditorialWriteRequestV2 } from '../../catalog-editorial/application/editorial-write-request-v2';
import { PrismaEditorialPublishWriter } from '../../catalog-editorial/infrastructure/prisma-editorial-publish-writer';
import { PrismaEditorialVocabularySnapshot } from '../../catalog-editorial/infrastructure/prisma-editorial-vocabulary-snapshot';
import {
  fact,
  installCanonicalVocabulary,
  known,
  readyDrafts,
  uninstallVocabulary,
} from '../../catalog-editorial/infrastructure/test-support/editorial-publication-postgres';
import {
  ListPublicProductsUseCase,
  type ListProductsInput,
} from '../application/use-cases/list-public-products.use-case';
import { ValidatePublicCartUseCase } from '../application/use-cases/validate-public-cart.use-case';
import { GetPublicProductDetailUseCase } from '../application/use-cases/get-public-product-detail.use-case';
import { PrismaPublicCatalogRepository } from './prisma-public-catalog.repository';

const tenantId = randomUUID();
const slug = 'pc-fct-' + tenantId.slice(0, 8);
const tenant = { id: tenantId, slug, name: 'PC Facets ' + slug };
const globalPriceListId = randomUUID();
const categoryId = randomUUID();
const editorId = randomUUID();

let prisma: PrismaClient;
let installed = false;
let revision: string;
let repo: PrismaPublicCatalogRepository;
let list: ListPublicProductsUseCase;
let cart: ValidatePublicCartUseCase;
let detail: GetPublicProductDetailUseCase;

async function setSwitch(on: boolean) {
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { catalogRequiresPublishedEditorial: on },
  });
}

async function context() {
  const resolved = await repo.resolveTenantCatalogContext(slug);
  if (!resolved) throw new Error('Expected the tenant catalog context');
  return resolved;
}

type Filters = Partial<Omit<ListProductsInput, 'sort'>>;

async function listWith(filters: Filters = {}) {
  return list.executeForContext({
    tenant,
    context: await context(),
    filters: {
      sort: 'newest',
      categoryId,
      ...filters,
      page: filters.page ?? 1,
      limit: filters.limit ?? 50,
    },
  });
}

const ids = (page: { items: { id: string }[] }) =>
  page.items.map((item) => item.id).sort();

async function validate(items: { productId: string; variantId?: string }[]) {
  return cart.executeForContext({
    tenant,
    context: await context(),
    items: items.map((item) => ({ ...item, quantity: 1 })),
  });
}

async function product(name: string, priceCents = 25000) {
  const productId = randomUUID();
  await prisma.product.create({
    data: {
      id: productId,
      tenantId,
      name,
      description: 'Descripción operativa ' + name,
      sku: 'pc-fct-' + productId.slice(0, 8),
      categoryId,
      quantity: 50,
    },
  });
  await prisma.priceList.create({
    data: { tenantId, productId, globalPriceListId, priceCents },
  });
  return productId;
}

async function addVariant(
  productId: string,
  priceListId: string,
  name: string,
) {
  const id = randomUUID();
  await prisma.variant.create({
    data: {
      id,
      tenantId,
      productId,
      name,
      option: 'Talla',
      value: name,
      quantity: 50,
    },
  });
  await prisma.variantPrice.create({
    data: { tenantId, variantId: id, priceListId, priceCents: 31000 },
  });
  return id;
}

async function variantProduct(name: string, variants: number) {
  const productId = randomUUID();
  await prisma.product.create({
    data: {
      id: productId,
      tenantId,
      name,
      sku: 'pc-fct-' + productId.slice(0, 8),
      categoryId,
      hasVariants: true,
    },
  });
  const priceList = await prisma.priceList.create({
    data: { tenantId, productId, globalPriceListId, priceCents: 30000 },
  });
  const variantIds: string[] = [];
  for (let i = 0; i < variants; i++)
    variantIds.push(await addVariant(productId, priceList.id, `T${i}`));
  return { productId, priceListId: priceList.id, variantIds };
}

type Facets = { animals: string[]; format: string; textures: string[] };

/** A ready food draft with the given FACET choices per subject. */
function foodDraft(
  subjects: { variantId: string | null; facets: Facets }[],
  text: { title: string; description: string | null },
) {
  const [row] = readyDrafts.food().facts;
  return {
    ...readyDrafts.food(),
    commercialTitle: text.title,
    description: text.description,
    values: subjects.flatMap(({ variantId, facets }) =>
      [
        known('animal.target', {
          type: 'multi',
          value: facets.animals.map((a) => 'ani.dom.' + a),
        }),
        known('food.format', {
          type: 'single',
          value: 'food.format.' + facets.format,
        }),
        known('food.texture', {
          type: 'multi',
          value: facets.textures.map((t) => 'food.texture.' + t),
        }),
        known('measure.net_mass', { type: 'number', value: 1.5, unit: 'kg' }),
        known('food.process', { type: 'multi', value: ['food.process.baked'] }),
      ].map((value) => ({ ...value, variantId })),
    ),
    facts: subjects.map(({ variantId }) => ({
      ...row,
      variantId,
      declarations: [fact('contentMagnitude', 'mass')],
    })),
  };
}

async function publish(
  productId: string,
  subjects: { variantId: string | null; facets: Facets }[],
  text: { title: string; description: string | null },
) {
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "catalog_editorial_states"
      ("tenantId", "productId", "cycle", "draftRevision", "draftDocument")
    VALUES (${tenantId}, ${productId}, 1, 1,
      CAST(${JSON.stringify(foodDraft(subjects, text))} AS JSONB))`);
  await new PrismaEditorialPublishWriter(prisma).publish(
    { actorId: editorId, tenantId, productId },
    'publish-' + randomUUID(),
    createEditorialWriteRequestV2(
      'publish',
      { vocabularyRevision: revision, careConfirmation: null },
      { expectedCycle: 1, expectedRevision: 1 },
    ),
  );
}

const simple = (facets: Facets) => [{ variantId: null, facets }];

// Fixture (all food, one category):
//   A simple   dog       kibble  dry
//   B simple   cat       pate    moist
//   C simple   dog+cat   pate    moist
//   V variants v0: dog kibble moist | v1: cat pate dry
//   X simple   dog       kibble  dry   — published, price removed (excluded)
//   U simple   unpublished
let A: string;
let B: string;
let C: string;
let V: Awaited<ReturnType<typeof variantProduct>>;
let X: string;
let U: string;

beforeAll(async () => {
  prisma = integrationPrisma();
  await installCanonicalVocabulary(prisma);
  installed = true;
  revision = (
    await readEditorialVocabulary(new PrismaEditorialVocabularySnapshot(prisma))
  ).vocabularyRevision;
  await prisma.tenant.create({
    data: {
      id: tenantId,
      name: tenant.name,
      slug,
      isActive: true,
      catalogPublished: true,
    },
  });
  await prisma.category.create({
    data: { id: categoryId, name: 'pc-fct-cat-' + categoryId.slice(0, 8) },
  });
  await prisma.globalPriceList.create({
    data: { id: globalPriceListId, name: 'pc-fct-' + globalPriceListId },
  });
  await prisma.tenantCatalogPriceList.create({
    data: { tenantId, globalPriceListId, isCatalogDefault: true },
  });
  const role = await prisma.role.create({
    data: { tenantId, name: 'pc-fct-editor' },
  });
  for (const action of ['read', 'update', 'publish']) {
    const permission = await prisma.permission.upsert({
      where: { subject_action: { subject: 'ProductEditorialDraft', action } },
      create: { subject: 'ProductEditorialDraft', action },
      update: {},
    });
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: permission.id },
    });
  }
  await prisma.user.create({
    data: {
      id: editorId,
      email: `editor-${editorId}@pc-fct.test`,
      hashedPassword: 'x',
      name: 'editor',
    },
  });
  await prisma.tenantMembership.create({
    data: { userId: editorId, tenantId, roleId: role.id },
  });

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
  repo = new PrismaPublicCatalogRepository(
    prisma as unknown as ConstructorParameters<
      typeof PrismaPublicCatalogRepository
    >[0],
    tenantPrisma,
  );
  list = new ListPublicProductsUseCase(repo);
  cart = new ValidatePublicCartUseCase(repo);
  detail = new GetPublicProductDetailUseCase(repo);

  A = await product('Operativo A');
  B = await product('Operativo B');
  C = await product('Operativo C');
  V = await variantProduct('Operativo V', 2);
  X = await product('Operativo X');
  U = await product('Operativo U');
  await publish(
    A,
    simple({ animals: ['dog'], format: 'kibble', textures: ['dry'] }),
    { title: 'Croquetas Alfa', description: 'Para perros ACTIVOS' },
  );
  await publish(
    B,
    simple({ animals: ['cat'], format: 'pate', textures: ['moist'] }),
    { title: 'Paté Beta', description: null },
  );
  await publish(
    C,
    simple({ animals: ['dog', 'cat'], format: 'pate', textures: ['moist'] }),
    { title: 'Paté Gamma 100%_natural', description: 'Húmedo' },
  );
  await publish(
    V.productId,
    [
      {
        variantId: V.variantIds[0],
        facets: { animals: ['dog'], format: 'kibble', textures: ['moist'] },
      },
      {
        variantId: V.variantIds[1],
        facets: { animals: ['cat'], format: 'pate', textures: ['dry'] },
      },
    ],
    { title: 'Mezcla Delta', description: null },
  );
  await publish(
    X,
    simple({ animals: ['dog'], format: 'kibble', textures: ['dry'] }),
    { title: 'Croquetas Equis', description: null },
  );
  // Published while offered, then its selected price goes away: excluded.
  await prisma.priceList.deleteMany({ where: { tenantId, productId: X } });
}, 120_000);

beforeEach(() => setSwitch(true));

afterAll(async () => {
  try {
    await prisma.$executeRaw(Prisma.sql`
      DELETE FROM "catalog_editorial_publish_receipts" WHERE "tenantId" = ${tenantId}`);
    await prisma.$executeRaw(Prisma.sql`
      DELETE FROM "catalog_editorial_states" WHERE "tenantId" = ${tenantId}`);
    await prisma.variantPrice.deleteMany({ where: { tenantId } });
    await prisma.variant.deleteMany({ where: { tenantId } });
    await prisma.priceList.deleteMany({ where: { tenantId } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.tenantMembership.deleteMany({ where: { tenantId } });
    await prisma.rolePermission.deleteMany({ where: { role: { tenantId } } });
    await prisma.role.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { id: editorId } });
    await prisma.tenantCatalogPriceList.deleteMany({ where: { tenantId } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.globalPriceList.deleteMany({
      where: { id: globalPriceListId },
    });
    await prisma.category.deleteMany({ where: { id: categoryId } });
  } finally {
    try {
      if (installed) await uninstallVocabulary(prisma);
    } finally {
      await disconnectIntegrationPrisma();
    }
  }
});

const animal = (...codes: string[]) => ({
  code: 'animal.target',
  options: codes.map((c) => 'ani.dom.' + c),
});
const format = (...codes: string[]) => ({
  code: 'food.format',
  options: codes.map((c) => 'food.format.' + c),
});
const texture = (...codes: string[]) => ({
  code: 'food.texture',
  options: codes.map((c) => 'food.texture.' + c),
});

/** `{ definition: { option: count } }` view of the facet response. */
function counts(page: Awaited<ReturnType<typeof listWith>>) {
  return Object.fromEntries(
    (page.facets.attributes ?? []).map((facet) => [
      facet.code,
      Object.fromEntries(facet.options.map((o) => [o.code, o.count])),
    ]),
  );
}

describe('public facet filters over Published editorial on PostgreSQL', () => {
  it('no selection: FACET choice counts over eligible products with vocabulary labels; no number/DETAIL facets', async () => {
    const page = await listWith();
    expect(ids(page)).toEqual([A, B, C, V.productId].sort());
    expect(page.excludedCount).toBe(1); // X has no price
    expect(counts(page)).toEqual({
      'animal.target': { 'ani.dom.dog': 3, 'ani.dom.cat': 3 },
      'food.format': { 'food.format.kibble': 2, 'food.format.pate': 3 },
      'food.texture': { 'food.texture.dry': 2, 'food.texture.moist': 3 },
    });
    const species = page.facets.attributes?.find(
      (f) => f.code === 'animal.target',
    );
    expect(species).toEqual({
      code: 'animal.target',
      label: 'Especie',
      options: [
        { code: 'ani.dom.cat', label: 'Gato', count: 3 },
        { code: 'ani.dom.dog', label: 'Perro', count: 3 },
      ],
    });
  });

  it('OR within a facet', async () => {
    expect(ids(await listWith({ attributeFacets: [animal('dog')] }))).toEqual(
      [A, C, V.productId].sort(),
    );
    const both = await listWith({ attributeFacets: [animal('dog', 'cat')] });
    expect(ids(both)).toEqual([A, B, C, V.productId].sort());
    expect(both.meta.total).toBe(4);
  });

  it('AND between facets, correlated on one sellable variant; counts exclude each facet own selection', async () => {
    // V has dog (v0) and pate (v1) but no single variant with both.
    const page = await listWith({
      attributeFacets: [animal('dog'), format('pate')],
    });
    expect(ids(page)).toEqual([C]);
    expect(page.meta.total).toBe(1);
    expect(counts(page)).toEqual({
      // format=pate applied: B(cat), C(dog,cat), V.v1(cat)
      'animal.target': { 'ani.dom.dog': 1, 'ani.dom.cat': 3 },
      // animal=dog applied: A(kibble), C(pate), V.v0(kibble)
      'food.format': { 'food.format.kibble': 2, 'food.format.pate': 1 },
      // both applied: C(moist)
      'food.texture': { 'food.texture.moist': 1 },
    });

    // dog AND dry: A only; V has dog on v0 and dry on v1 → not a match.
    expect(
      ids(await listWith({ attributeFacets: [animal('dog'), texture('dry')] })),
    ).toEqual([A]);
    // cat AND dry: V.v1.
    expect(
      ids(await listWith({ attributeFacets: [animal('cat'), texture('dry')] })),
    ).toEqual([V.productId]);
  });

  it('a selected option with no match stays in the facets with count 0; empty result is a clean empty page', async () => {
    const page = await listWith({
      attributeFacets: [format('kibble'), texture('moist'), animal('cat')],
    });
    expect(page.items).toEqual([]);
    expect(page.meta).toEqual({ page: 1, limit: 50, total: 0, totalPages: 0 });
    expect(counts(page)['animal.target']).toEqual({
      'ani.dom.cat': 0,
      'ani.dom.dog': 1,
    });
  });

  it('unique products before pagination; excludedCount and categories under the same filter', async () => {
    const filters = { attributeFacets: [animal('dog', 'cat')], limit: 3 };
    const first = await listWith({ ...filters, page: 1 });
    const second = await listWith({ ...filters, page: 2 });
    expect(first.meta).toEqual({ page: 1, limit: 3, total: 4, totalPages: 2 });
    expect(second.items).toHaveLength(1);
    expect([...ids(first), ...ids(second)].sort()).toEqual(
      [A, B, C, V.productId].sort(),
    );
    expect(first.facets.categories).toEqual([
      expect.objectContaining({ id: categoryId, count: 4 }),
    ]);

    const dog = await listWith({ attributeFacets: [animal('dog')] });
    expect(dog.excludedCount).toBe(1); // X matches but has no price
    const cat = await listWith({ attributeFacets: [animal('cat')] });
    expect(cat.excludedCount).toBe(0);
  });

  it('a variant offered after the publish neither matches nor counts', async () => {
    const later = await addVariant(V.productId, V.priceListId, 'Nueva');
    try {
      // Same coverage as before: v0/v1 only.
      expect(
        ids(
          await listWith({ attributeFacets: [animal('cat'), texture('dry')] }),
        ),
      ).toEqual([V.productId]);
    } finally {
      await prisma.variantPrice.deleteMany({ where: { variantId: later } });
      await prisma.variant.delete({ where: { id: later } });
    }
  });

  it('unknown definition, unknown option, non-FACET and number FACET definitions are 400 (InvalidArgumentError)', async () => {
    for (const selection of [
      { code: 'nope.def', options: ['x'] },
      { code: 'animal.target', options: ['ani.dom.dragon'] },
      { code: 'food.process', options: ['food.process.baked'] }, // DETAIL
      { code: 'measure.net_mass', options: ['kg'] }, // number FACET
      { code: 'food.format', options: ['ani.dom.dog'] }, // other definition's option
    ])
      await expect(
        listWith({ attributeFacets: [selection] }),
      ).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it('switch off: facet selection is 400 and the response carries no attribute facets', async () => {
    await setSwitch(false);
    await expect(
      listWith({ attributeFacets: [animal('dog')] }),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
    const page = await listWith();
    expect(Object.keys(page.facets)).toEqual(['categories']);
    expect(ids(page)).toEqual([A, B, C, V.productId, U].sort());
  });
});

describe('public search over Published editorial on PostgreSQL', () => {
  it('switch on: q matches Published title and description case-insensitively, not operational names', async () => {
    expect(ids(await listWith({ q: 'alfa' }))).toEqual([A]);
    expect(ids(await listWith({ q: 'activos' }))).toEqual([A]); // description
    expect(ids(await listWith({ q: 'PATÉ' }))).toEqual([B, C].sort());
    expect(ids(await listWith({ q: 'húmedo' }))).toEqual([C]);
    expect((await listWith({ q: 'operativo' })).items).toEqual([]);
    expect((await listWith({ q: 'T0' })).items).toEqual([]); // variant name
  });

  it('switch on: LIKE wildcards in q behave exactly like today (not escaped)', async () => {
    expect(ids(await listWith({ q: '100%_n' }))).toEqual([C]);
    expect(ids(await listWith({ q: '%' }))).toEqual(
      [A, B, C, V.productId].sort(),
    );
    expect(ids(await listWith({ q: 'Pat_' }))).toEqual([B, C].sort());
  });

  it('switch on: q combines with facets and the counts follow q', async () => {
    const page = await listWith({
      q: 'paté',
      attributeFacets: [animal('dog')],
    });
    expect(ids(page)).toEqual([C]);
    expect(counts(page)['animal.target']).toEqual({
      'ani.dom.dog': 1,
      'ani.dom.cat': 2,
    });
  });

  it('switch off: q still matches operational names and variant fields', async () => {
    await setSwitch(false);
    expect(ids(await listWith({ q: 'operativo' }))).toEqual(
      [A, B, C, V.productId, U].sort(),
    );
    expect(ids(await listWith({ q: 'T0' }))).toEqual([V.productId]);
    expect((await listWith({ q: 'alfa' })).items).toEqual([]); // Today's contains does not escape LIKE wildcards (pre-existing).
    expect(ids(await listWith({ q: '%' }))).toEqual(
      [A, B, C, V.productId, U].sort(),
    );
  });
});

describe('public cart validation over Published editorial on PostgreSQL', () => {
  it('switch on: an unpublished product is NOT_IN_CATALOG with the redacted contract; published is VALID', async () => {
    const result = await validate([{ productId: U }, { productId: A }]);
    expect(result.items[0]).toEqual({
      productId: U,
      variantId: null,
      productName: null,
      variantName: null,
      image: null,
      quantity: 1,
      status: 'BLOCKED',
      blockingCodes: ['NOT_IN_CATALOG'],
      warnings: ['NOT_IN_CATALOG'],
      unitPriceCents: null,
      lineTotalCents: null,
      availability: 'out_of_stock',
      priceHidden: false,
    });
    expect(result.items[1].status).toBe('VALID');
    expect(result.valid).toBe(false);
  });

  it('switch on: a variant not covered by the Published revision is VARIANT_NOT_IN_CATALOG; covered is VALID', async () => {
    const later = await addVariant(V.productId, V.priceListId, 'Nueva');
    try {
      const result = await validate([
        { productId: V.productId, variantId: later },
        { productId: V.productId, variantId: V.variantIds[0] },
      ]);
      expect(result.items[0]).toMatchObject({
        status: 'BLOCKED',
        blockingCodes: ['VARIANT_NOT_IN_CATALOG'],
        productName: null,
      });
      expect(result.items[1].status).toBe('VALID');

      await setSwitch(false);
      const off = await validate([
        { productId: V.productId, variantId: later },
      ]);
      expect(off.items[0].status).toBe('VALID');
    } finally {
      await prisma.variantPrice.deleteMany({ where: { variantId: later } });
      await prisma.variant.delete({ where: { id: later } });
    }
  });

  it('switch off: the unpublished product validates exactly as today', async () => {
    await setSwitch(false);
    const result = await validate([{ productId: U }]);
    expect(result.items[0]).toMatchObject({
      status: 'VALID',
      productName: 'Operativo U',
    });
  });
});

describe('a Published row that is not a valid V2 document counts as not published', () => {
  /** Pre-V2 Published row as found on the dev DB: no schemaVersion/facts, no payload. */
  const legacyDocument = {
    commercialTitle: 'Croquetas Legado',
    description: 'Documento anterior a V2',
    familyCode: 'food',
    mediaRefs: [],
    values: [
      {
        code: 'animal.target',
        type: 'multi',
        owner: 'sellable',
        value: ['ani.dom.dog'],
        variantId: null,
      },
    ],
  };
  /** Top-level V2 shape, but a value without its payload: fails the deep parse. */
  const brokenDocument = {
    schemaVersion: 2,
    commercialTitle: 'Croquetas Rotas',
    description: null,
    familyCode: 'food',
    mediaRefs: [],
    values: [
      {
        code: 'animal.target',
        owner: 'sellable',
        state: 'known',
        variantId: null,
      },
    ],
    facts: [],
  };

  async function storePublished(productId: string, document: object) {
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "catalog_editorial_states"
        ("tenantId", "productId", "cycle", "publishedRevision", "publishedDocument")
      VALUES (${tenantId}, ${productId}, 1, 2, CAST(${JSON.stringify(document)} AS JSONB))`);
  }

  async function detailMiss(productId: string): Promise<unknown> {
    const error = await detail
      .executeForContext({ productId, tenant, context: await context() })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(NotFoundException);
    return (error as NotFoundException).getResponse();
  }

  let L: string;
  let K: string;
  let warn: jest.SpyInstance;

  beforeAll(async () => {
    L = await product('Operativo Legado');
    K = await product('Operativo Roto');
    await storePublished(L, legacyDocument);
    await storePublished(K, brokenDocument);
  });

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(() => warn.mockRestore());

  afterAll(async () => {
    await prisma.$executeRaw(Prisma.sql`
      DELETE FROM "catalog_editorial_states"
      WHERE "tenantId" = ${tenantId} AND "productId" IN (${L}, ${K})`);
    await prisma.priceList.deleteMany({
      where: { tenantId, productId: { in: [L, K] } },
    });
    await prisma.product.deleteMany({ where: { id: { in: [L, K] } } });
  });

  it('switch on: the list is 200 with only the valid products; a legacy row adds nothing to counts or facets', async () => {
    const page = await listWith();
    expect(ids(page)).toEqual([A, B, C, V.productId].sort());
    expect(page.meta.total).toBe(4);
    expect(page.excludedCount).toBe(1);
    expect(counts(page)['animal.target']).toEqual({
      'ani.dom.dog': 3,
      'ani.dom.cat': 3,
    });
    expect(page.facets.categories).toEqual([
      expect.objectContaining({ id: categoryId, count: 4 }),
    ]);
    expect(ids(await listWith({ attributeFacets: [animal('dog')] }))).toEqual(
      [A, C, V.productId].sort(),
    );
  });

  it('switch on: search never reaches the text of an invalid Published row', async () => {
    expect((await listWith({ q: 'Legado' })).items).toEqual([]);
    expect((await listWith({ q: 'Rotas' })).items).toEqual([]);
  });

  it('switch on: detail of an invalid Published row is the generic 404', async () => {
    const miss = await detailMiss(randomUUID());
    expect(await detailMiss(L)).toEqual(miss);
    expect(await detailMiss(K)).toEqual(miss);
  });

  it('switch on: cart validation treats an invalid Published row as NOT_IN_CATALOG', async () => {
    const result = await validate([{ productId: L }, { productId: K }]);
    for (const item of result.items)
      expect(item).toMatchObject({
        status: 'BLOCKED',
        blockingCodes: ['NOT_IN_CATALOG'],
        productName: null,
      });
  });

  it('logs one warning per request with the product ids, never document contents', async () => {
    await listWith();
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] as [string];
    expect(message).toContain(L);
    expect(message).toContain(K);
    for (const text of ['Legado', 'Rotas', 'animal.target'])
      expect(message).not.toContain(text);
  });

  it('switch off: both products show exactly like any operational product', async () => {
    await setSwitch(false);
    const page = await listWith();
    expect(ids(page)).toEqual(expect.arrayContaining([L, K]));
    expect(warn).not.toHaveBeenCalled();
  });
});
