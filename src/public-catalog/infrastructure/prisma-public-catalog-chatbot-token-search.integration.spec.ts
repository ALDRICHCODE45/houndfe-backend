/**
 * INTEGRATION SPEC: chatbot token search (opt-in `chatbotTokenSearch`) over the
 * real PostgreSQL test DB (never dev/prod). Every row is created under fresh
 * tenants, so results never depend on baseline data; brands/categories are
 * global tables, so their names carry a random suffix and are deleted FK-safe.
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { ClsService } from 'nestjs-cls';
import { disconnectIntegrationPrisma } from '../../../test/integration/reset-db';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { PrismaPublicCatalogRepository } from './prisma-public-catalog.repository';

const SKIP_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const describeIfDb = SKIP_INTEGRATION ? describe.skip : describe;

describeIfDb('Chatbot token search (Integration - Real DB)', () => {
  let prisma: PrismaClient;
  let repo: PrismaPublicCatalogRepository;
  let currentTenantId: string;
  let tenantId: string;
  let otherTenantId: string;
  let suffix: string;
  const tenantIds: string[] = [];
  const productIds: string[] = [];
  const variantIds: string[] = [];
  const brandIds: string[] = [];
  const categoryIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    const cls = {
      get: (key: string) => {
        if (key === 'tenantId') return currentTenantId;
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
  });

  beforeEach(async () => {
    suffix = randomUUID().slice(0, 8);
    tenantId = await seedTenant();
    otherTenantId = await seedTenant();
    currentTenantId = tenantId;
  });

  afterEach(async () => {
    try {
      await prisma.variant.deleteMany({ where: { id: { in: variantIds } } });
      await prisma.product.deleteMany({ where: { id: { in: productIds } } });
      await prisma.brand.deleteMany({ where: { id: { in: brandIds } } });
      await prisma.category.deleteMany({ where: { id: { in: categoryIds } } });
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    } finally {
      for (const list of [
        tenantIds,
        productIds,
        variantIds,
        brandIds,
        categoryIds,
      ]) {
        list.length = 0;
      }
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await disconnectIntegrationPrisma();
  });

  async function seedTenant(): Promise<string> {
    const id = randomUUID();
    await prisma.tenant.create({
      data: {
        id,
        name: `ct-int tenant ${id.slice(0, 8)}`,
        slug: `ct-int-${id.slice(0, 8)}`,
        isActive: true,
        catalogPublished: true,
      },
    });
    tenantIds.push(id);
    return id;
  }

  async function seedBrand(name: string): Promise<string> {
    const id = randomUUID();
    await prisma.brand.create({ data: { id, name: `${name} ${suffix}` } });
    brandIds.push(id);
    return id;
  }

  async function seedCategory(name: string): Promise<string> {
    const id = randomUUID();
    await prisma.category.create({ data: { id, name: `${name} ${suffix}` } });
    categoryIds.push(id);
    return id;
  }

  async function seedProduct(
    name: string,
    opts: {
      tenant?: string;
      brandId?: string;
      categoryId?: string;
      include?: boolean;
      createdAt?: Date;
    } = {},
  ): Promise<string> {
    const id = randomUUID();
    await prisma.product.create({
      data: {
        id,
        name,
        tenantId: opts.tenant ?? tenantId,
        brandId: opts.brandId,
        categoryId: opts.categoryId,
        includeInOnlineCatalog: opts.include ?? true,
        createdAt: opts.createdAt,
      },
    });
    productIds.push(id);
    return id;
  }

  async function seedVariantProduct(
    name: string,
    variantName: string,
  ): Promise<string> {
    const id = await seedProduct(name);
    await prisma.product.update({
      where: { id },
      data: { hasVariants: true },
    });
    const variantId = randomUUID();
    await prisma.variant.create({
      data: {
        id: variantId,
        productId: id,
        tenantId,
        name: variantName,
        catalogPublishMode: 'INHERIT',
      },
    });
    variantIds.push(variantId);
    return id;
  }

  const search = (
    q: string | undefined,
    extra: { page?: number; limit?: number; flag?: boolean } = {},
  ) =>
    repo.findProducts({
      q,
      chatbotMgSpacing: true,
      chatbotTokenSearch: extra.flag ?? true,
      sort: 'relevance',
      page: extra.page ?? 1,
      limit: extra.limit ?? 20,
    });

  const names = (r: { items: Array<{ name: string }> }) =>
    r.items.map((i) => i.name);

  it('S1: "croquetas pedigree" finds both Pedigree products through the OR fallback', async () => {
    await seedProduct('Pedigree Adulto Trozos de Res en Salsa Lata 375 g');
    await seedProduct('Pedigree Dentastix Razas Medianas');
    await seedProduct('Whiskas Gato Adulto Pollo');

    const result = await search('croquetas pedigree');

    expect(names(result).sort()).toEqual([
      'Pedigree Adulto Trozos de Res en Salsa Lata 375 g',
      'Pedigree Dentastix Razas Medianas',
    ]);
    expect(result.total).toBe(2);
  });

  it('S1: "alimento para gato" finds a brand+gato product via category, dropping the stopword', async () => {
    const category = await seedCategory('Alimento Seco');
    await seedProduct(`Whiskas Gato Adulto Pollo`, { categoryId: category });
    await seedProduct('Shampoo para perro');
    await seedProduct('Collar para gato'); // matches "gato" only: AND has results

    const result = await search('alimento para gato');

    expect(names(result)).toEqual(['Whiskas Gato Adulto Pollo']);
  });

  it('S1: a cat product found by brand + name word under AND', async () => {
    const brand = await seedBrand('Whiskas');
    await seedProduct('Gato Adulto Pollo', { brandId: brand });
    await seedProduct('Gato Cachorro Atun');

    const result = await search(`whiskas ${suffix} GATO`);

    expect(names(result)).toEqual(['Gato Adulto Pollo']);
  });

  it('matches case- and accent-insensitively in both directions', async () => {
    const category = await seedCategory('Alimentó Húmedo');
    await seedProduct('Cañón Pequeño', { categoryId: category });
    await seedProduct('Gato Adulto');

    expect(names(await search('GATO'))).toEqual(['Gato Adulto']);
    expect(names(await search('CANON pequeno'))).toEqual(['Cañón Pequeño']);
    expect(names(await search('cañón'))).toEqual(['Cañón Pequeño']);
    expect(names(await search(`alimento humedo ${suffix} canon`))).toEqual([
      'Cañón Pequeño',
    ]);
    expect(names(await search('ALIMENTÓ'))).toEqual(['Cañón Pequeño']);
  });

  it('prefers AND over OR when AND has results', async () => {
    await seedProduct('Pedigree Adulto Res');
    await seedProduct('Pedigree Cachorro Pollo');

    expect(names(await search('pedigree adulto'))).toEqual([
      'Pedigree Adulto Res',
    ]);
  });

  it('ranks the OR fallback by matched-token count, then newest first', async () => {
    await seedProduct('Alpha uno', { createdAt: new Date('2026-01-03') });
    await seedProduct('Alpha dos', { createdAt: new Date('2026-01-02') });
    await seedProduct('Alpha beta', { createdAt: new Date('2026-01-01') });
    await seedProduct('Unrelated item');

    // "gamma" matches nothing, so AND on all three tokens is empty -> OR.
    const result = await search('alpha beta gamma');

    expect(names(result)).toEqual(['Alpha beta', 'Alpha uno', 'Alpha dos']);
    expect(result.total).toBe(3);
  });

  it('paginates the ranked OR fallback', async () => {
    await seedProduct('Alpha uno', { createdAt: new Date('2026-01-03') });
    await seedProduct('Alpha dos', { createdAt: new Date('2026-01-02') });
    await seedProduct('Alpha beta', { createdAt: new Date('2026-01-01') });

    const page1 = await search('alpha beta gamma', { limit: 2 });
    const page2 = await search('alpha beta gamma', { limit: 2, page: 2 });

    expect(names(page1)).toEqual(['Alpha beta', 'Alpha uno']);
    expect(names(page2)).toEqual(['Alpha dos']);
    expect(page1.total).toBe(3);
    expect(page2.total).toBe(3);
  });

  it('matches variant name text per token', async () => {
    await seedVariantProduct('Royal Canin', 'Gato Esterilizado 2 kg');

    expect(names(await search('royal gato'))).toEqual(['Royal Canin']);
  });

  it('keeps the integer mg spacing tolerance', async () => {
    await seedProduct('Ibuprofeno de 400mg');
    await seedProduct('Ibuprofeno de 800mg');

    expect(names(await search('ibuprofeno de 400 mg'))).toEqual([
      'Ibuprofeno de 400mg',
    ]);
  });

  it('keeps tenant scoping and publication gates; a gated AND match does not suppress OR results', async () => {
    await seedProduct('Pedigree Adulto Res');
    await seedProduct('Pedigree Adulto Res', { tenant: otherTenantId });
    await seedProduct('Pedigree Adulto Hidden', { include: false });
    await seedProduct('Pedigree Solo');

    // "res" matches "Pedigree Adulto Res" in our tenant only.
    expect(names(await search('pedigree res'))).toEqual([
      'Pedigree Adulto Res',
    ]);
    // Hidden product cannot satisfy AND; "hidden" matches nothing visible so
    // the OR fallback runs and returns the visible "pedigree" rows.
    expect(names(await search('pedigree hidden')).sort()).toEqual([
      'Pedigree Adulto Res',
      'Pedigree Solo',
    ]);
  });

  it("blank q keeps today's behavior (no text filter)", async () => {
    await seedProduct('Uno');
    await seedProduct('Dos');

    const flagged = await search('');
    const baseline = await search(undefined, { flag: false });

    expect(flagged.total).toBe(2);
    expect(names(flagged).sort()).toEqual(names(baseline).sort());
  });

  it('punctuation-only q falls back to the existing whole-phrase predicate', async () => {
    await seedProduct('Bolsa 100% algodon');
    await seedProduct('Otro');

    const flagged = await search('%');
    const legacy = await search('%', { flag: false });

    expect(names(flagged).sort()).toEqual(names(legacy).sort());
    expect(flagged.total).toBe(legacy.total);
  });

  it('returns the same item shape as the existing search', async () => {
    await seedProduct('Pedigree Adulto Res');

    const token = await search('Pedigree Adulto Res');
    const legacy = await search('Pedigree Adulto Res', { flag: false });

    expect(token.items).toHaveLength(1);
    expect(token).toEqual(legacy);
  });

  it('public (opt-out) search keeps whole-phrase matching: multi-word q finds nothing', async () => {
    await seedProduct('Pedigree Adulto Trozos de Res en Salsa Lata 375 g');

    const result = await search('croquetas pedigree', { flag: false });

    expect(result).toEqual({ items: [], total: 0 });
  });
});
