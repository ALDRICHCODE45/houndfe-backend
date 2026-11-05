/**
 * INTEGRATION SPEC: public catalog from Published editorial (P4 T3: S2 S3 S5).
 *
 * Real PostgreSQL, real publish/unpublish writers and the real public use
 * cases over the real repository. The canonical production vocabulary is
 * installed into the empty test vocabulary and truncated afterwards.
 */
import { NotFoundException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { ClsService } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';
import {
  disconnectIntegrationPrisma,
  integrationPrisma,
} from '../../../test/integration/reset-db';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { readEditorialVocabulary } from '../../catalog-editorial/application/editorial-vocabulary-read';
import { createEditorialWriteRequestV2 } from '../../catalog-editorial/application/editorial-write-request-v2';
import { PrismaEditorialPublishWriter } from '../../catalog-editorial/infrastructure/prisma-editorial-publish-writer';
import { PrismaEditorialUnpublishWriter } from '../../catalog-editorial/infrastructure/prisma-editorial-unpublish-writer';
import { PrismaEditorialVocabularySnapshot } from '../../catalog-editorial/infrastructure/prisma-editorial-vocabulary-snapshot';
import {
  fact,
  installCanonicalVocabulary,
  known,
  readyDrafts,
  uninstallVocabulary,
} from '../../catalog-editorial/infrastructure/test-support/editorial-publication-postgres';
import { GetPublicProductDetailUseCase } from '../application/use-cases/get-public-product-detail.use-case';
import { ListPublicProductsUseCase } from '../application/use-cases/list-public-products.use-case';
import { PrismaPublicCatalogRepository } from './prisma-public-catalog.repository';

const tenantId = randomUUID();
const slug = 'pc-pub-' + tenantId.slice(0, 8);
const tenant = { id: tenantId, slug, name: 'PC Published ' + slug };
const globalPriceListId = randomUUID();
const categoryId = randomUUID();
const editorId = randomUUID();

let prisma: PrismaClient;
let installed = false;
let revision: string;
let repo: PrismaPublicCatalogRepository;
let list: ListPublicProductsUseCase;
let detail: GetPublicProductDetailUseCase;

const intent = (operation: 'publish' | 'unpublish', body: object) =>
  createEditorialWriteRequestV2(
    operation,
    { vocabularyRevision: revision, careConfirmation: null },
    body,
  );
const scopeOf = (productId: string) => ({
  actorId: editorId,
  tenantId,
  productId,
});

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

async function listAll(filters: { page?: number; limit?: number } = {}) {
  return list.executeForContext({
    tenant,
    context: await context(),
    filters: {
      sort: 'newest',
      page: filters.page ?? 1,
      limit: filters.limit ?? 50,
      categoryId,
    },
  });
}

async function detailOf(productId: string) {
  return detail.executeForContext({
    productId,
    tenant,
    context: await context(),
  });
}

/** The exact miss body today's detail returns for a product that never existed. */
async function notFoundBody(productId: string): Promise<unknown> {
  const error = await detailOf(productId).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(NotFoundException);
  return (error as NotFoundException).getResponse();
}

async function simpleProduct(name: string, priceCents = 25000) {
  const productId = randomUUID();
  await prisma.product.create({
    data: {
      id: productId,
      tenantId,
      name,
      description: 'Descripción operativa ' + name,
      sku: 'pc-pub-' + productId.slice(0, 8),
      categoryId,
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
  priceCents: number,
) {
  const id = randomUUID();
  await prisma.variant.create({
    data: { id, tenantId, productId, name, option: 'Talla', value: name },
  });
  await prisma.variantPrice.create({
    data: { tenantId, variantId: id, priceListId, priceCents },
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
      description: 'Descripción operativa ' + name,
      sku: 'pc-pub-' + productId.slice(0, 8),
      categoryId,
      hasVariants: true,
    },
  });
  const priceList = await prisma.priceList.create({
    data: { tenantId, productId, globalPriceListId, priceCents: 30000 },
  });
  const variantIds: string[] = [];
  for (let i = 0; i < variants; i++)
    variantIds.push(
      await addVariant(productId, priceList.id, `T${i}`, 30000 + i * 1000),
    );
  return { productId, priceListId: priceList.id, variantIds };
}

const ingredients = 'Pollo, arroz y maíz';
const clinical = 'Proteína cruda 26% (análisis interno)';

/** A ready food draft: FACET, DETAIL and INTERNAL values for each subject. */
function foodDraft(
  subjects: (string | null)[],
  text: { title: string; description: string | null },
) {
  const base = readyDrafts.food();
  const [row] = base.facts;
  const values = [
    known('animal.target', {
      type: 'multi',
      value: ['ani.dom.dog', 'ani.dom.cat'],
    }),
    known('food.format', { type: 'single', value: 'food.format.kibble' }),
    known('measure.net_mass', { type: 'number', value: 1.5, unit: 'kg' }),
    known('food.process', { type: 'multi', value: ['food.process.baked'] }),
    known('text.ingredients', { type: 'text', value: ingredients }),
    known('text.clinical_analysis', { type: 'text', value: clinical }),
  ];
  return {
    ...base,
    commercialTitle: text.title,
    description: text.description,
    values: subjects.flatMap((variantId) =>
      values.map((value) => ({ ...value, variantId })),
    ),
    facts: subjects.map((variantId) => ({
      ...row,
      variantId,
      declarations: [fact('contentMagnitude', 'mass')],
    })),
  };
}

async function publishEditorial(
  productId: string,
  subjects: (string | null)[],
  text: { title: string; description: string | null },
) {
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "catalog_editorial_states"
      ("tenantId", "productId", "cycle", "draftRevision", "draftDocument")
    VALUES (${tenantId}, ${productId}, 1, 1,
      CAST(${JSON.stringify(foodDraft(subjects, text))} AS JSONB))`);
  await new PrismaEditorialPublishWriter(prisma).publish(
    scopeOf(productId),
    'publish-' + randomUUID(),
    intent('publish', { expectedCycle: 1, expectedRevision: 1 }),
  );
}

async function draftOnly(productId: string) {
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "catalog_editorial_states"
      ("tenantId", "productId", "cycle", "draftRevision", "draftDocument")
    VALUES (${tenantId}, ${productId}, 1, 1,
      CAST(${JSON.stringify(foodDraft([null], { title: 'Borrador', description: null }))} AS JSONB))`);
}

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
    data: { id: categoryId, name: 'pc-pub-cat-' + categoryId.slice(0, 8) },
  });
  await prisma.globalPriceList.create({
    data: { id: globalPriceListId, name: 'pc-pub-' + globalPriceListId },
  });
  await prisma.tenantCatalogPriceList.create({
    data: { tenantId, globalPriceListId, isCatalogDefault: true },
  });
  const role = await prisma.role.create({
    data: { tenantId, name: 'pc-pub-editor' },
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
      email: `editor-${editorId}@pc-pub.test`,
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
  detail = new GetPublicProductDetailUseCase(repo);
}, 60_000);

beforeEach(() => setSwitch(false));

afterAll(async () => {
  try {
    await prisma.$executeRaw(Prisma.sql`
      DELETE FROM "catalog_editorial_publish_receipts" WHERE "tenantId" = ${tenantId}`);
    await prisma.$executeRaw(Prisma.sql`
      DELETE FROM "catalog_editorial_unpublish_receipts" WHERE "tenantId" = ${tenantId}`);
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

describe('public catalog from Published editorial on PostgreSQL', () => {
  let simple: string;
  let variants: Awaited<ReturnType<typeof variantProduct>>;
  let unpublished: string;
  let drafted: string;

  it('switch off: list and detail are identical before and after publishing (no editorial data)', async () => {
    simple = await simpleProduct('Croqueta operativa');
    variants = await variantProduct('Croqueta con tallas', 2);
    unpublished = await simpleProduct('Sin editorial');
    drafted = await simpleProduct('Solo borrador');

    const before = {
      list: await listAll(),
      simple: await detailOf(simple),
      variants: await detailOf(variants.productId),
    };
    expect(before.list.items.map((item) => item.id).sort()).toEqual(
      [simple, variants.productId, unpublished, drafted].sort(),
    );

    await publishEditorial(simple, [null], {
      title: 'Croquetas Indoor para perro y gato 1.5 kg',
      description: 'Croquetas horneadas para interiores.',
    });
    await publishEditorial(variants.productId, variants.variantIds, {
      title: 'Croquetas por talla',
      description: null,
    });
    await draftOnly(drafted);

    const after = {
      list: await listAll(),
      simple: await detailOf(simple),
      variants: await detailOf(variants.productId),
    };
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(after.simple).not.toHaveProperty('attributes');
    expect(after.simple.name).toBe('Croqueta operativa');
  });

  it('switch on: only Published products are listed; others 404 with the generic body', async () => {
    await setSwitch(true);
    const page = await listAll();
    expect(page.items.map((item) => item.id).sort()).toEqual(
      [simple, variants.productId].sort(),
    );
    expect(page.meta).toEqual({ page: 1, limit: 50, total: 2, totalPages: 1 });
    expect(page.excludedCount).toBe(0);
    expect(page.facets.categories).toEqual([
      expect.objectContaining({ id: categoryId, count: 2 }),
    ]);

    // Unique products and consistent pagination before slicing.
    const first = await listAll({ page: 1, limit: 1 });
    const second = await listAll({ page: 2, limit: 1 });
    expect(first.meta).toEqual({ page: 1, limit: 1, total: 2, totalPages: 2 });
    expect(second.meta.total).toBe(2);
    expect(
      [...first.items, ...second.items].map((item) => item.id).sort(),
    ).toEqual([simple, variants.productId].sort());

    const miss = await notFoundBody(randomUUID());
    expect(await notFoundBody(unpublished)).toEqual(miss);
    expect(await notFoundBody(drafted)).toEqual(miss);
  });

  it('switch on: Published title and description replace the operational ones in cards and detail', async () => {
    await setSwitch(true);
    const cards = new Map((await listAll()).items.map((i) => [i.id, i]));
    expect(cards.get(simple)).toMatchObject({
      name: 'Croquetas Indoor para perro y gato 1.5 kg',
      description: 'Croquetas horneadas para interiores.',
    });
    // A null Published description replaces the operational one too.
    expect(cards.get(variants.productId)).toMatchObject({
      name: 'Croquetas por talla',
      description: null,
    });
    expect(cards.get(simple)).not.toHaveProperty('attributes');

    const body = await detailOf(simple);
    expect(body.name).toBe('Croquetas Indoor para perro y gato 1.5 kg');
    expect(body.description).toBe('Croquetas horneadas para interiores.');
  });

  it('switch on: detail projects FACET and DETAIL attributes with vocabulary labels; never INTERNAL, evidence or facts', async () => {
    await setSwitch(true);
    const body = await detailOf(simple);
    expect(body.attributes).toEqual([
      {
        code: 'animal.target',
        label: 'Especie',
        facet: true,
        section: { code: 'para-quien', label: 'Para quién' },
        value: {
          type: 'multi',
          options: [
            { code: 'ani.dom.dog', label: 'Perro' },
            { code: 'ani.dom.cat', label: 'Gato' },
          ],
        },
        display: 'Perro, Gato',
      },
      expect.objectContaining({
        code: 'food.format',
        facet: true,
        value: {
          type: 'single',
          option: { code: 'food.format.kibble', label: 'Croquetas' },
        },
        display: 'Croquetas',
      }),
      expect.objectContaining({ code: 'food.process', facet: false }),
      expect.objectContaining({
        code: 'text.ingredients',
        facet: false,
        value: { type: 'text', text: ingredients },
        display: ingredients,
      }),
      expect.objectContaining({
        code: 'measure.net_mass',
        label: 'Peso neto',
        facet: true,
        value: {
          type: 'number',
          value: 1.5,
          unit: { code: 'kg', label: 'kg' },
        },
        display: '1.5 kg',
      }),
    ]);
    const serialized = JSON.stringify(body);
    for (const secret of [
      clinical,
      'text.clinical_analysis',
      'Etiqueta del empaque',
      'verifiedOn',
      'Dice el empaque',
      'contentMagnitude',
      'careReview',
      'declarations',
      'evidence',
    ])
      expect(serialized).not.toContain(secret);

    // Variant products: sellable values ride on each visible variant.
    const variantBody = await detailOf(variants.productId);
    expect(variantBody.attributes).toEqual([]);
    for (const variant of variantBody.variants)
      expect(variant.attributes?.map((a) => a.code)).toEqual([
        'animal.target',
        'food.format',
        'food.process',
        'text.ingredients',
        'measure.net_mass',
      ]);
    expect(JSON.stringify(variantBody)).not.toContain(clinical);
  });

  it('switch on: a variant offered after the publish is hidden; no covered sellable left means excluded/404', async () => {
    await setSwitch(true);
    // Cheaper than every covered variant: it must not move the card price.
    const later = await addVariant(
      variants.productId,
      variants.priceListId,
      'Nueva',
      100,
    );
    const body = await detailOf(variants.productId);
    expect(body.variants.map((v) => v.id).sort()).toEqual(
      [...variants.variantIds].sort(),
    );
    const card = (await listAll()).items.find(
      (item) => item.id === variants.productId,
    );
    expect(card?.price.fromPriceCents).toBe(30000);

    // Switch off: the operational variant shows as it does today.
    await setSwitch(false);
    expect(
      (await detailOf(variants.productId)).variants.map((v) => v.id),
    ).toContain(later);

    // Only an uncovered offered variant remains: the product disappears.
    const lonely = await variantProduct('Una talla', 1);
    await publishEditorial(lonely.productId, lonely.variantIds, {
      title: 'Una talla publicada',
      description: null,
    });
    await prisma.variant.update({
      where: { id: lonely.variantIds[0] },
      data: { catalogPublishMode: 'OFF' },
    });
    await addVariant(lonely.productId, lonely.priceListId, 'Nueva', 900);
    await setSwitch(true);
    expect((await listAll()).items.map((i) => i.id)).not.toContain(
      lonely.productId,
    );
    expect(await notFoundBody(lonely.productId)).toEqual(
      await notFoundBody(randomUUID()),
    );
    await setSwitch(false);
    expect((await listAll()).items.map((i) => i.id)).toContain(
      lonely.productId,
    );
  });

  it('switch on: unpublish removes the product from the public catalog immediately', async () => {
    await setSwitch(true);
    expect((await listAll()).items.map((i) => i.id)).toContain(simple);
    await new PrismaEditorialUnpublishWriter(prisma).unpublish(
      scopeOf(simple),
      'unpublish-' + randomUUID(),
      intent('unpublish', { expectedCycle: 1, expectedRevision: 1 }),
    );
    const page = await listAll();
    expect(page.items.map((i) => i.id)).not.toContain(simple);
    expect(page.meta.total).toBe(1);
    expect(await notFoundBody(simple)).toEqual(
      await notFoundBody(randomUUID()),
    );
  });
});
