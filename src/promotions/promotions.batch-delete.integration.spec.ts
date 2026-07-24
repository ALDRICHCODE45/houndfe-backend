/**
 * batch-delete integration spec — end-to-end coverage of the four
 * critical response paths for `POST /promotions/batch-delete`:
 *
 *  - 200: 5 valid unreferenced ids → { deleted: 5 }
 *  - 400: empty array / non-UUID / >100 ids → validation 400
 *  - 409: an id referenced by a SaleItem → all-or-nothing rollback,
 *         0 rows deleted, response carries offendingIds + reason
 *  - 404: cross-tenant id → BATCH_DELETE_NOT_FOUND → 404
 *
 * The 403 (missing batch_delete permission) is asserted via the
 * BatchDeleteGuard spec in src/shared/batch-delete/guards/.
 *
 * Spec: pos-promotion-engine/spec.md R11, R12, R13.
 *
 * Run filtered: `pnpm run test:integration -- promotions.batch-delete.integration.spec.ts`.
 */
import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import {
  resetAndSeedBaseline,
  disconnectIntegrationPrisma,
} from '../../test/integration/reset-db';
import { PrismaService } from '../shared/prisma/prisma.service';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import { PrismaPromotionRepository } from './infrastructure/prisma-promotion.repository';
import { PromotionsService } from './promotions.service';
import { PromotionsController } from './promotions.controller';
import { AuthModule } from '../auth/auth.module';
import { CaslAbilityFactory } from '../auth/authorization/casl-ability.factory';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import type { TenantClsStore } from '../shared/tenant/tenant-cls-store.interface';
import { BatchDeleteModule } from '../shared/batch-delete/batch-delete.module';
import { BatchDeleteGuard } from '../shared/batch-delete/guards/batch-delete.guard';
import { PROMOTION_REPOSITORY } from './domain/promotion.repository';
import { AppActions, AppSubjects } from '../auth/authorization/domain/permission';
import { PERMISSION_REGISTRY } from '../auth/authorization/domain/permission';

const SKIP_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const describeIfDb = SKIP_INTEGRATION ? describe.skip : describe;

// UUID helpers — promote / sale IDs are UUIDs in the schema.
const promoId = (i: number) =>
  `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const productId = (i: number) =>
  `00000000-0000-4000-8001-${String(i).padStart(12, '0')}`;
const customerId = (i: number) =>
  `00000000-0000-4000-8002-${String(i).padStart(12, '0')}`;
const sellerId = () => `00000000-0000-4000-8003-000000000001`;
const tenantId = () => `00000000-0000-4000-8004-000000000001`;
const userId = () => `00000000-0000-4000-8005-000000000001`;

describeIfDb('Promotions POST /promotions/batch-delete (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenantPrisma: TenantPrismaService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    await resetAndSeedBaseline();

    // Ensure the seeded batch_delete:Promotion row exists (the seed
    // script seeds PERMISSION_REGISTRY but tests must not depend on
    // it having run). Insert-if-missing.
    await prisma.permission.upsert({
      where: {
        subject_action: {
          subject: 'Promotion',
          action: 'batch_delete',
        },
      },
      update: {},
      create: {
        subject: 'Promotion',
        action: 'batch_delete',
        description: 'Eliminar múltiples promociones a la vez',
      },
    });

    const cls: Pick<ClsService<TenantClsStore>, 'get' | 'set'> = {
      get: (key: string) => {
        if (key === 'tenantId') return tenantId();
        if (key === 'userId') return userId();
        if (key === 'isSuperAdmin') return false;
        return undefined;
      },
      set: () => undefined,
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        AuthModule,
        BatchDeleteModule.forFeature(),
      ],
      controllers: [PromotionsController],
      providers: [
        PromotionsService,
        ConfigService,
        {
          provide: TenantPrismaService,
          useValue: {
            getClient: () => prisma,
            runInTransaction: async <T>(work: () => Promise<T>) => work(),
            getTenantId: () => tenantId(),
            isInTransaction: () => false,
          },
        },
        {
          provide: ClsService,
          useValue: cls,
        },
        {
          provide: PROMOTION_REPOSITORY,
          useClass: PrismaPromotionRepository,
        },
        {
          // Wire the BatchDeleteOrchestrator with TenantPrismaService +
          // PromotionsService (the BatchDeletableService for promotions).
          provide: BatchDeleteOrchestrator,
          useFactory: (
            tenantPrisma: TenantPrismaService,
            service: PromotionsService,
          ): BatchDeleteOrchestrator =>
            new (class extends BatchDeleteOrchestrator {
              constructor() {
                super(tenantPrisma, service);
              }
            })(),
          inject: [TenantPrismaService, PromotionsService],
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(TenantContextGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionsGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(BatchDeleteGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await disconnectIntegrationPrisma();
  });

  beforeEach(async () => {
    // Wipe promotion rows + their cascade joins between scenarios so
    // each test starts on a clean slate. The fixture also wipes
    // SaleItem + SalePromotionApplied so the FK guard test is
    // deterministic.
    await prisma.saleItem.deleteMany({});
    await prisma.salePromotionApplied.deleteMany({});
    await prisma.sale.deleteMany({});
    await prisma.promotion.deleteMany({});

    // Sanity-check the registry constant — guards against accidental
    // removal of the registry entry in a future refactor.
    const hasRegistryEntry = PERMISSION_REGISTRY.some(
      (p) =>
        p.subject === ('Promotion' as AppSubjects) &&
        p.action === ('batch_delete' as AppActions),
    );
    expect(hasRegistryEntry).toBe(true);
  });

  async function seedPromotions(count: number): Promise<string[]> {
    const ids = Array.from({ length: count }, (_, i) => promoId(i + 1));
    for (const id of ids) {
      await prisma.promotion.create({
        data: {
          id,
          tenantId: tenantId(),
          title: `seed ${id}`,
          type: 'PRODUCT_DISCOUNT',
          method: 'AUTOMATIC',
          status: 'ACTIVE',
          customerScope: 'ALL',
          discountType: 'PERCENTAGE',
          discountValue: 10,
        },
      });
    }
    return ids;
  }

  it('200 — happy path: 5 unreferenced ids are deleted', async () => {
    const ids = await seedPromotions(5);

    const res = await request(app.getHttpServer())
      .post('/promotions/batch-delete')
      .send({ ids });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 5 });

    const remaining = await prisma.promotion.findMany({
      where: { id: { in: ids } },
    });
    expect(remaining).toHaveLength(0);
  });

  it('400 — empty array is rejected by DTO validation', async () => {
    const res = await request(app.getHttpServer())
      .post('/promotions/batch-delete')
      .send({ ids: [] });

    expect(res.status).toBe(400);
  });

  it('400 — non-UUID entries are rejected', async () => {
    const res = await request(app.getHttpServer())
      .post('/promotions/batch-delete')
      .send({ ids: ['not-a-uuid'] });

    expect(res.status).toBe(400);
  });

  it('400 — over 100 ids is rejected', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => promoId(i + 1));
    const res = await request(app.getHttpServer())
      .post('/promotions/batch-delete')
      .send({ ids });

    expect(res.status).toBe(400);
  });

  it('409 — SaleItem reference blocks the entire batch (all-or-nothing)', async () => {
    const ids = await seedPromotions(3);
    const referencedId = ids[1];

    // Seed a sale + a SaleItem that references the middle promotion.
    // SaleItem.promotionId is SetNull on delete — but the pre-flight
    // guard catches the reference BEFORE the delete runs, so the
    // whole batch is rejected.
    const sale = await prisma.sale.create({
      data: {
        tenantId: tenantId(),
        sellerId: sellerId(),
        customerId: customerId(1),
        status: 'CONFIRMED',
        saleNumber: 1,
        subtotalCents: 0,
        totalCents: 0,
      },
    });
    await prisma.saleItem.create({
      data: {
        tenantId: tenantId(),
        saleId: sale.id,
        productId: productId(1),
        productName: 'P',
        quantity: 1,
        unitPriceCents: 100,
        promotionId: referencedId,
      },
    });

    const res = await request(app.getHttpServer())
      .post('/promotions/batch-delete')
      .send({ ids });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('PROMOTION_REFERENCED_BY_SALE');
    expect(res.body.offendingIds).toEqual([referencedId]);
    expect(res.body.reason).toBeDefined();

    // All-or-nothing: nothing was deleted.
    const remaining = await prisma.promotion.findMany({
      where: { id: { in: ids } },
    });
    expect(remaining).toHaveLength(3);
  });

  it('404 — ids that do not exist in the tenant are reported as NOT_FOUND', async () => {
    const existingIds = await seedPromotions(2);
    const missingIds = [promoId(99), promoId(100)];

    const res = await request(app.getHttpServer())
      .post('/promotions/batch-delete')
      .send({ ids: [...existingIds, ...missingIds] });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('BATCH_DELETE_NOT_FOUND');
    expect([...res.body.offendingIds].sort()).toEqual(
      [...missingIds].sort(),
    );

    // The existing ids are NOT deleted because the pre-flight rejected
    // the batch.
    const remaining = await prisma.promotion.findMany({
      where: { id: { in: existingIds } },
    });
    expect(remaining).toHaveLength(2);
  });
});