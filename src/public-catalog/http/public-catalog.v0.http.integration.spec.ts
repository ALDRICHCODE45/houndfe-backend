/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- supertest bodies are untyped JSON */
/**
 * INTEGRATION SPEC (HTTP): public catalog v0 — S1 sort, S3 exactQuantity, S4
 * branch card, S5 bot WhatsApp number, S6 share preview.
 *
 * Real PostgreSQL (test DB, never dev), real repository and use cases, the
 * real controllers behind supertest. Only the environment values are faked
 * through ConfigService; the module wiring of the production module is
 * compiled by `public-catalog.module.spec.ts`.
 */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { PrismaClient } from '@prisma/client';
import { ClsModule } from 'nestjs-cls';
import request from 'supertest';
import { disconnectIntegrationPrisma } from '../../../test/integration/reset-db';
import { OpeningHoursService } from '../../shipping/pickup/application/opening-hours.service';
import { PickupLocationService } from '../../shipping/pickup/application/pickup-location.service';
import { DomainExceptionFilter } from '../../shared/filters/domain-exception.filter';
import { createAppValidationPipe } from '../../shared/listing/app-validation.pipe';
import { DatabaseModule } from '../../shared/prisma/prisma.module';
import { GetPublicBranchUseCase } from '../application/use-cases/get-public-branch.use-case';
import { GetPublicProductDetailUseCase } from '../application/use-cases/get-public-product-detail.use-case';
import { ListPublicBranchesUseCase } from '../application/use-cases/list-public-branches.use-case';
import { ListPublicPriceContextsUseCase } from '../application/use-cases/list-public-price-contexts.use-case';
import { ListPublicProductsUseCase } from '../application/use-cases/list-public-products.use-case';
import { ValidatePublicCartUseCase } from '../application/use-cases/validate-public-cart.use-case';
import { PublicCatalogConfig } from '../application/services/public-catalog-config';
import { PublicPriceContextResolver } from '../application/services/public-price-context-resolver';
import { PUBLIC_CATALOG_REPOSITORY } from '../application/ports/public-catalog.repository';
import { PrismaPublicCatalogRepository } from '../infrastructure/prisma-public-catalog.repository';
import { PublicTenantGuard } from './guards/public-tenant.guard';
import { PublicBranchController } from './public-branch.controller';
import { PublicCatalogController } from './public-catalog.controller';
import {
  SharePreviewController,
  SharePreviewMissFilter,
} from './share-preview.controller';

const describeIfDb =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL
    ? describe.skip
    : describe;

describeIfDb('public catalog v0 over HTTP (PostgreSQL)', () => {
  const tenantId = randomUUID();
  const slug = `pc-v0-${tenantId.slice(0, 8)}`;
  const emptyTenantId = randomUUID();
  const emptySlug = `pc-v0-e-${emptyTenantId.slice(0, 8)}`;
  const listA = randomUUID();
  const listB = randomUUID();
  const categoryId = randomUUID();
  const env: Record<string, string | undefined> = {};
  const STORE = 'https://sistem.houndfe.com/catalogo';
  let prisma: PrismaClient;
  let app: INestApplication;
  const ids: Record<string, string> = {};

  async function product(
    name: string,
    opts: {
      priceA: number;
      priceB?: number;
      quantity?: number;
      minQuantity?: number;
      variants?: { name: string; priceA: number; quantity: number }[];
      createdAt?: Date;
      hidePrice?: boolean;
      description?: string;
      image?: string;
    },
  ) {
    const productId = randomUUID();
    ids[name] = productId;
    await prisma.product.create({
      data: {
        id: productId,
        tenantId,
        name,
        description: opts.description ?? null,
        sku: `pc-v0-${productId.slice(0, 8)}`,
        categoryId,
        quantity: opts.quantity ?? 50,
        minQuantity: opts.minQuantity ?? 3,
        hasVariants: Boolean(opts.variants),
        hidePriceInOnlineCatalog: opts.hidePrice ?? false,
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      },
    });
    const rowA = await prisma.priceList.create({
      data: {
        tenantId,
        productId,
        globalPriceListId: listA,
        priceCents: opts.priceA,
      },
    });
    if (opts.priceB !== undefined)
      await prisma.priceList.create({
        data: {
          tenantId,
          productId,
          globalPriceListId: listB,
          priceCents: opts.priceB,
        },
      });
    for (const v of opts.variants ?? []) {
      const variantId = randomUUID();
      ids[v.name] = variantId;
      await prisma.variant.create({
        data: {
          id: variantId,
          tenantId,
          productId,
          name: v.name,
          option: 'Talla',
          value: v.name,
          quantity: v.quantity,
          minQuantity: 3,
          sku: `pc-v0-v-${variantId.slice(0, 8)}`,
        },
      });
      await prisma.variantPrice.create({
        data: {
          tenantId,
          variantId,
          priceListId: rowA.id,
          priceCents: v.priceA,
        },
      });
    }
    if (opts.image)
      await prisma.productImage.create({
        data: {
          tenantId,
          productId,
          url: opts.image,
          isMain: true,
          sortOrder: 0,
        },
      });
    return productId;
  }

  const get = (path: string) => request(app.getHttpServer()).get(path);

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    const moduleRef = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        DatabaseModule,
        ThrottlerModule.forRoot([
          { name: 'public-browse', ttl: 60_000, limit: 1000 },
          { name: 'public-validate', ttl: 60_000, limit: 1000 },
        ]),
      ],
      controllers: [
        PublicCatalogController,
        PublicBranchController,
        SharePreviewController,
      ],
      providers: [
        PublicTenantGuard,
        ListPublicBranchesUseCase,
        ListPublicPriceContextsUseCase,
        ListPublicProductsUseCase,
        GetPublicProductDetailUseCase,
        ValidatePublicCartUseCase,
        GetPublicBranchUseCase,
        PublicPriceContextResolver,
        PublicCatalogConfig,
        SharePreviewMissFilter,
        OpeningHoursService,
        PickupLocationService,
        {
          provide: PUBLIC_CATALOG_REPOSITORY,
          useClass: PrismaPublicCatalogRepository,
        },
        {
          provide: ConfigService,
          useValue: { get: (key: string) => env[key] },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createAppValidationPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.init();

    for (const [id, name] of [
      [tenantId, 'PC V0 Centro'],
      [emptyTenantId, 'PC V0 Vacía'],
    ] as const)
      await prisma.tenant.create({
        data: {
          id,
          name,
          slug: id === tenantId ? slug : emptySlug,
          isActive: true,
          catalogPublished: true,
          phone: id === tenantId ? '+525512345678' : null,
        },
      });
    await prisma.category.create({
      data: { id: categoryId, name: `pc-v0-cat-${categoryId.slice(0, 8)}` },
    });
    for (const [listId, isDefault] of [
      [listA, true],
      [listB, false],
    ] as const) {
      await prisma.globalPriceList.create({
        data: { id: listId, name: `pc-v0-${listId}` },
      });
      for (const id of [tenantId, emptyTenantId])
        await prisma.tenantCatalogPriceList.create({
          data: {
            tenantId: id,
            globalPriceListId: listId,
            isCatalogDefault: isDefault,
          },
        });
    }

    const t = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n));
    await product('Cara', { priceA: 9000, priceB: 100, createdAt: t(1) });
    await product('Media', { priceA: 5000, priceB: 200, createdAt: t(2) });
    await product('Barata', { priceA: 1000, priceB: 300, createdAt: t(3) });
    // Product price 9500, but the card says «desde 1500».
    await product('Tallas', {
      priceA: 9500,
      createdAt: t(4),
      variants: [
        { name: 'Chica', priceA: 1500, quantity: 2 },
        { name: 'Grande', priceA: 7000, quantity: 40 },
      ],
    });
    await product('Oculto', { priceA: 1, hidePrice: true, createdAt: t(5) });
    await product('Pocas', {
      priceA: 2000,
      quantity: 2,
      minQuantity: 3,
      createdAt: t(6),
    });
    await product('Croquetas "><script>alert(1)</script>', {
      priceA: 4000,
      description: 'Para perros   adultos',
      image: 'https://cdn.example.com/croquetas.jpg',
      createdAt: t(7),
    });
  }, 60_000);

  afterAll(async () => {
    try {
      await app?.close();
      const where = { tenantId: { in: [tenantId, emptyTenantId] } };
      await prisma.productImage.deleteMany({ where });
      await prisma.variantPrice.deleteMany({ where });
      await prisma.variant.deleteMany({ where });
      await prisma.priceList.deleteMany({ where });
      await prisma.product.deleteMany({ where });
      await prisma.tenantCatalogPriceList.deleteMany({ where });
      await prisma.tenant.deleteMany({
        where: { id: { in: [tenantId, emptyTenantId] } },
      });
      await prisma.globalPriceList.deleteMany({
        where: { id: { in: [listA, listB] } },
      });
      await prisma.category.deleteMany({ where: { id: categoryId } });
    } finally {
      await prisma.$disconnect();
      await disconnectIntegrationPrisma();
    }
  });

  describe('S1 sort', () => {
    const nameOf = (id: string) =>
      Object.entries(ids).find(([, value]) => value === id)?.[0];
    const listNames = async (query: string) => {
      const res = await get(`/public/catalog/${slug}/products?${query}`).expect(
        200,
      );
      return {
        names: (res.body.items as { id: string }[]).map((i) => nameOf(i.id)),
        meta: res.body.meta as { total: number; totalPages: number },
      };
    };
    const XSS = 'Croquetas "><script>alert(1)</script>';

    it('price_asc across pages is the global order by «desde», hidden last', async () => {
      const full = [
        'Barata', // 1000
        'Tallas', // «desde» 1500 (product price 9500 ignored)
        'Pocas', // 2000
        XSS, // 4000
        'Media', // 5000
        'Cara', // 9000
        'Oculto', // hidden last
      ];
      expect((await listNames('sort=price_asc&limit=50')).names).toEqual(full);
      const pages: Awaited<ReturnType<typeof listNames>>[] = [];
      for (const page of [1, 2, 3, 4])
        pages.push(await listNames(`sort=price_asc&limit=2&page=${page}`));
      expect(pages.flatMap((p) => p.names)).toEqual(full);
      expect(pages[0].meta).toMatchObject({ total: 7, totalPages: 4 });
    });

    it('price_desc reverses prices, keeps hidden last, and honours the selected price list', async () => {
      expect((await listNames('sort=price_desc&limit=50')).names).toEqual([
        'Cara',
        'Media',
        XSS,
        'Pocas',
        'Tallas',
        'Barata',
        'Oculto',
      ]);
      // List B prices only exist on three products; the rest are not
      // eligible there, so they are excluded (not sorted).
      const list = await listNames(
        `sort=price_asc&limit=50&priceListId=${listB}`,
      );
      expect(list.names).toEqual(['Cara', 'Media', 'Barata', 'Oculto']);
    });

    it('previous behavior holds: newest/relevance/rating_desc stay createdAt desc', async () => {
      const newest = [
        XSS,
        'Pocas',
        'Oculto',
        'Tallas',
        'Barata',
        'Media',
        'Cara',
      ];
      for (const sort of ['newest', 'relevance', 'rating_desc'])
        expect((await listNames(`sort=${sort}&limit=50`)).names).toEqual(
          newest,
        );
      expect((await listNames('limit=50')).names).toEqual(newest);
    });
  });

  describe('S3 exactQuantity', () => {
    const detail = (name: string) =>
      get(`/public/catalog/${slug}/products/${ids[name]}`).expect(200);
    const card = async (name: string) => {
      const res = await get(`/public/catalog/${slug}/products?limit=50`).expect(
        200,
      );
      return (
        res.body.items as { id: string; stockPresentation: object }[]
      ).find((i) => i.id === ids[name]);
    };
    afterEach(() =>
      prisma.tenant.update({
        where: { id: tenantId },
        data: { catalogStockPresentationDefault: 'SYSTEM_STATUS' },
      }),
    );

    it('is absent for the default tenant (previous behavior holds)', async () => {
      expect((await card('Pocas'))?.stockPresentation).toEqual({
        mode: 'SYSTEM_STATUS',
        status: 'low_stock',
        customQuantity: null,
      });
    });

    it('opt-in tenant: low_stock carries the real quantity on cards and detail', async () => {
      await prisma.tenant.update({
        where: { id: tenantId },
        data: {
          catalogStockPresentationDefault: 'SYSTEM_STATUS_EXACT_LOW_STOCK',
        },
      });
      expect((await card('Pocas'))?.stockPresentation).toEqual({
        mode: 'SYSTEM_STATUS_EXACT_LOW_STOCK',
        status: 'low_stock',
        customQuantity: null,
        exactQuantity: 2,
      });
      expect((await card('Media'))?.stockPresentation).toMatchObject({
        status: 'available',
        exactQuantity: null,
      });
      expect((await detail('Pocas')).body.stockPresentation.exactQuantity).toBe(
        2,
      );
    });

    it('variant product: product row null, each variant row its own quantity', async () => {
      await prisma.tenant.update({
        where: { id: tenantId },
        data: {
          catalogStockPresentationDefault: 'SYSTEM_STATUS_EXACT_LOW_STOCK',
        },
      });
      const body = (await detail('Tallas')).body as {
        stockPresentation: { exactQuantity: number | null };
        variants: {
          name: string;
          stockPresentation: { status: string; exactQuantity: number | null };
        }[];
      };
      expect(body.stockPresentation.exactQuantity).toBeNull();
      expect(
        body.variants.map((v) => [
          v.name,
          v.stockPresentation.status,
          v.stockPresentation.exactQuantity,
        ]),
      ).toEqual(
        expect.arrayContaining([
          ['Chica', 'low_stock', 2],
          ['Grande', 'available', null],
        ]),
      );
    });
  });

  describe('S4 branch card and S5 WhatsApp number', () => {
    beforeAll(async () => {
      await prisma.shippingOrigin.create({
        data: {
          tenantId,
          addressLine1: 'Av. Juárez 123',
          neighborhood: 'Centro',
          municipality: 'Cuauhtémoc',
          state: 'CDMX',
          postalCode: '06000',
          contactPhone: '+525599999999',
        },
      });
      await prisma.tenantOpeningHours.create({
        data: {
          tenantId,
          timeZone: 'America/Mexico_City',
          days: [
            'MONDAY',
            'TUESDAY',
            'WEDNESDAY',
            'THURSDAY',
            'FRIDAY',
            'SATURDAY',
            'SUNDAY',
          ].map((day) => ({
            day,
            ranges: day === 'SUNDAY' ? [] : [{ open: '09:00', close: '18:00' }],
          })),
        },
      });
      for (const [zipCode, type] of [
        ['06000', 'DENIED'],
        ['06100', 'CARRIER_ONLY'],
      ] as const)
        await prisma.deliveryZone.create({
          data: {
            tenantId,
            zipCode,
            type,
            isActive: zipCode === '06100',
            approvedById: randomUUID(),
            approvedByDisplayName: 'test',
            approvedAt: new Date(),
          },
        });
    });
    afterEach(() => {
      delete env.PUBLIC_BOT_WHATSAPP;
    });

    it('returns name, phone, address, hours, flags and the bot number with a 300s public cache', async () => {
      env.PUBLIC_BOT_WHATSAPP = '+5215500000000';
      const res = await get(`/public/catalog/${slug}/branch`).expect(200);
      expect(res.headers['cache-control']).toBe('public, max-age=300');
      expect(res.body).toMatchObject({
        name: 'PC V0 Centro',
        phone: '+525512345678',
        pickupAvailable: true,
        deliveryAvailable: true,
        whatsappNumber: '+5215500000000',
        address: {
          addressLine1: 'Av. Juárez 123',
          postalCode: '06000',
          formatted: expect.stringContaining('Av. Juárez 123'),
        },
        hours: {
          timeZone: 'America/Mexico_City',
          summary: expect.any(String),
        },
      });
      expect(res.body.hours.days).toHaveLength(7);
      expect(res.body.hours.days[0]).toEqual({
        day: 'MONDAY',
        label: 'Lunes',
        closed: false,
        ranges: [{ open: '09:00', close: '18:00' }],
      });
      expect(res.body.hours.days[6]).toMatchObject({
        closed: true,
        ranges: [],
      });
    });

    it('never leaks the internal contact phone or tenant ids', async () => {
      const res = await get(`/public/catalog/${slug}/branch`).expect(200);
      const text = JSON.stringify(res.body);
      expect(text).not.toContain('+525599999999');
      expect(text).not.toContain('contactPhone');
      expect(text).not.toContain(tenantId);
    });

    it('a branch with nothing configured answers nulls and false flags; whatsappNumber null when unset', async () => {
      const res = await get(`/public/catalog/${emptySlug}/branch`).expect(200);
      expect(res.body).toEqual({
        name: 'PC V0 Vacía',
        phone: null,
        address: null,
        hours: null,
        pickupAvailable: false,
        deliveryAvailable: false,
        whatsappNumber: null,
      });
    });

    it('same gate as the other public routes: unknown or unpublished slug is 404', async () => {
      await get('/public/catalog/no-such-slug/branch').expect(404);
      await prisma.tenant.update({
        where: { id: emptyTenantId },
        data: { catalogPublished: false },
      });
      try {
        await get(`/public/catalog/${emptySlug}/branch`).expect(404);
      } finally {
        await prisma.tenant.update({
          where: { id: emptyTenantId },
          data: { catalogPublished: true },
        });
      }
    });

    it('/branches lists whatsappNumber on every branch (null when unset); other fields unchanged', async () => {
      const pick = async () => {
        const res = await get('/public/catalog/branches').expect(200);
        return (res.body as { slug: string }[]).find((b) => b.slug === slug);
      };
      expect(await pick()).toEqual({
        id: tenantId,
        name: 'PC V0 Centro',
        slug,
        address: null,
        phone: '+525512345678',
        whatsappNumber: null,
      });
      env.PUBLIC_BOT_WHATSAPP = '+5215500000000';
      expect(await pick()).toMatchObject({ whatsappNumber: '+5215500000000' });
    });
  });

  describe('S6 share preview', () => {
    const XSS = 'Croquetas "><script>alert(1)</script>';
    beforeEach(() => {
      env.PUBLIC_STORE_URL = STORE;
    });
    afterEach(() => {
      delete env.PUBLIC_STORE_URL;
      delete env.PUBLIC_SHARE_BASE_URL;
    });

    it('serves og tags and a redirect to the storefront product, with a 300s public cache', async () => {
      const res = await get(`/share/${slug}/p/${ids.Media}`).expect(200);
      const target = `${STORE}/${slug}/p/${ids.Media}`;
      expect(res.headers['content-type']).toMatch(/^text\/html/);
      expect(res.headers['cache-control']).toBe('public, max-age=300');
      expect(res.text).toContain('og:title" content="Media"');
      expect(res.text).toContain(`og:url" content="${target}"`);
      expect(res.text).toContain(`content="0;url=${target}"`);
      expect(res.text).toContain(`location.replace("${target}")`);
      expect(res.text).toContain('twitter:card');
    });

    it('carries the description and the main image, never a price', async () => {
      const res = await get(`/share/${slug}/p/${ids[XSS]}`).expect(200);
      expect(res.text).toContain(
        'og:description" content="Para perros adultos"',
      );
      expect(res.text).toContain(
        'og:image" content="https://cdn.example.com/croquetas.jpg"',
      );
      expect(res.text).toContain('summary_large_image');
      const hidden = await get(`/share/${slug}/p/${ids.Oculto}`).expect(200);
      for (const html of [res.text, hidden.text]) {
        expect(html).not.toMatch(/4000|40\.00|\$|price|precio/i);
      }
    });

    it('escapes a product name that tries to inject markup', async () => {
      const res = await get(`/share/${slug}/p/${ids[XSS]}`).expect(200);
      expect(res.text).not.toContain('<script>alert(1)');
      expect(res.text).toContain(
        '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;',
      );
      expect(res.text.match(/<script>/g)).toHaveLength(1);
    });

    it('preserves a valid ?priceListId and ignores anything else', async () => {
      const kept = await get(
        `/share/${slug}/p/${ids.Media}?priceListId=${listB}`,
      ).expect(200);
      expect(kept.text).toContain(
        `${STORE}/${slug}/p/${ids.Media}?priceListId=${listB}`,
      );
      const bad = await get(
        `/share/${slug}/p/${ids.Media}?priceListId="><script>alert(2)</script>`,
      ).expect(200);
      expect(bad.text).not.toContain('priceListId');
      expect(bad.text).not.toContain('alert(2)');
      expect(bad.text).toContain(
        `location.replace("${STORE}/${slug}/p/${ids.Media}")`,
      );
    });

    it.each([
      ['unknown product', () => `/share/${slug}/p/${randomUUID()}`],
      ['malformed product id', () => `/share/${slug}/p/not-a-uuid`],
      ['unknown tenant', () => `/share/no-such-slug/p/${randomUUID()}`],
      ['product of another tenant', () => `/share/${emptySlug}/p/${ids.Media}`],
    ])(
      '%s: 404 page that redirects to the store home, no og tags',
      async (_l, path) => {
        const res = await get(path()).expect(404);
        expect(res.text).toContain(`location.replace("${STORE}")`);
        expect(res.text).toContain(`content="0;url=${STORE}"`);
        expect(res.text).not.toContain('og:title');
      },
    );

    it('a stale ?priceListId (valid UUID the tenant does not publish) previews and redirects to the product without the param', async () => {
      const stale = randomUUID();
      env.PUBLIC_SHARE_BASE_URL = 'https://api.houndfe.com';
      const res = await get(
        `/share/${slug}/p/${ids.Media}?priceListId=${stale}`,
      ).expect(200);
      const target = `${STORE}/${slug}/p/${ids.Media}`;
      expect(res.headers['cache-control']).toBe('public, max-age=300');
      // og tags come from the default context.
      expect(res.text).toContain('og:title" content="Media"');
      expect(res.text).toContain(`content="0;url=${target}"`);
      expect(res.text).toContain(`location.replace("${target}")`);
      expect(res.text).toContain(
        `og:url" content="https://api.houndfe.com/share/${slug}/p/${ids.Media}"`,
      );
      // The stale id is never echoed anywhere.
      expect(res.text).not.toContain(stale);
      expect(res.text).not.toContain('priceListId');
    });

    it('a stale ?priceListId on an unknown product still goes to the store home', async () => {
      const res = await get(
        `/share/${slug}/p/${randomUUID()}?priceListId=${randomUUID()}`,
      ).expect(404);
      expect(res.text).toContain(`location.replace("${STORE}")`);
      expect(res.text).not.toContain('og:title');
    });

    it('og:url is the /share URL when PUBLIC_SHARE_BASE_URL is set, with the valid priceListId', async () => {
      env.PUBLIC_SHARE_BASE_URL = 'https://api.houndfe.com/';
      const plain = await get(`/share/${slug}/p/${ids.Media}`).expect(200);
      expect(plain.text).toContain(
        `og:url" content="https://api.houndfe.com/share/${slug}/p/${ids.Media}"`,
      );
      // The redirect target stays the storefront.
      expect(plain.text).toContain(
        `content="0;url=${STORE}/${slug}/p/${ids.Media}"`,
      );
      const withList = await get(
        `/share/${slug}/p/${ids.Media}?priceListId=${listB}`,
      ).expect(200);
      expect(withList.text).toContain(
        `og:url" content="https://api.houndfe.com/share/${slug}/p/${ids.Media}?priceListId=${listB}"`,
      );
      expect(withList.text).toContain(
        `content="0;url=${STORE}/${slug}/p/${ids.Media}?priceListId=${listB}"`,
      );
    });

    it('og:url falls back to the storefront URL when PUBLIC_SHARE_BASE_URL is unset (previous behavior)', async () => {
      const res = await get(`/share/${slug}/p/${ids.Media}`).expect(200);
      expect(res.text).toContain(
        `og:url" content="${STORE}/${slug}/p/${ids.Media}"`,
      );
      expect(res.text).not.toContain('/share/');
    });

    it('answers 503 with no redirect when PUBLIC_STORE_URL is unset', async () => {
      delete env.PUBLIC_STORE_URL;
      for (const path of [
        `/share/${slug}/p/${ids.Media}`,
        `/share/no-such-slug/p/${ids.Media}`,
      ]) {
        const res = await get(path).expect(503);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.text).not.toContain('<meta');
      }
    });

    it('tolerates a trailing slash in PUBLIC_STORE_URL', async () => {
      env.PUBLIC_STORE_URL = `${STORE}/`;
      const res = await get(`/share/${slug}/p/${ids.Media}`).expect(200);
      expect(res.text).toContain(
        `og:url" content="${STORE}/${slug}/p/${ids.Media}"`,
      );
    });
  });
});
