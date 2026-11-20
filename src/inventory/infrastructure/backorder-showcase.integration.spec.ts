/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-require-imports -- the showcase script is plain CommonJS; supertest bodies are untyped JSON */
/**
 * restock-backorder / T5b (L13) — `scripts/dev-showcase/backorders.cjs` against
 * REAL PostgreSQL, in a throwaway tenant (never the shared baseline):
 *
 *  - dry run writes nothing; apply creates every state (WAITING with
 *    passedOverCount > 0, RESERVED, CONFIRMED with its sale, EXPIRED,
 *    CANCELLED by customer and by staff) and reports the folios;
 *  - idempotent: a second run creates nothing and changes nothing;
 *  - the journal agrees with the stock (Σ deltas = product quantity, running
 *    balances) and every constraint of the backorders table accepted the rows;
 *  - the REAL app reads the samples: GET /products/:id reports
 *    reservedForBackorders for the RESERVED one and `revalidateReservation`
 *    finds its units held (VALID);
 *  - the journal rows are shaped exactly like the ones the real allocator and
 *    `releaseBackorder` write (same bucket kind, group, delta sign, actor).
 */
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ClsService } from 'nestjs-cls';
import request from 'supertest';
import type { App } from 'supertest/types';
import { BackorderReservationService } from '../../backorders/application/backorder-reservation.service';
import { BackordersModule } from '../../backorders/backorders.module';
import {
  createZoneTestApp,
  disconnectWorldPrisma,
  SKIP_DB_INTEGRATION,
  TEST_JWT_SECRET,
  worldPrisma,
  ZoneWorld,
} from '../../delivery-zones/test-support/delivery-zone-world';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { StockJournalWriter } from './stock-journal.writer';

const showcase = require(
  path.resolve(__dirname, '../../../scripts/dev-showcase/backorders.cjs'),
);

const describeIfDb = SKIP_DB_INTEGRATION ? describe.skip : describe;
const DAY = 86_400_000;

describeIfDb('dev showcase: sample backorders (PostgreSQL)', () => {
  const prisma = worldPrisma();
  const world = new ZoneWorld();
  const userIds: string[] = [];
  const createdPriceListIds: string[] = [];
  const tenantIds: string[] = [];
  let app: INestApplication;
  let cls: ClsService<TenantClsStore>;
  let tenantPrisma: TenantPrismaService;
  let writer: StockJournalWriter;
  let reservations: BackorderReservationService;
  let publicListId: string;
  const server = () => app.getHttpServer() as App;

  beforeAll(async () => {
    const existingDefault = await prisma.globalPriceList.findFirst({
      where: { isDefault: true },
    });
    if (existingDefault) {
      publicListId = existingDefault.id;
    } else {
      const created = await prisma.globalPriceList.create({
        data: { name: `PUBLICO-showcase-${randomUUID()}`, isDefault: true },
      });
      createdPriceListIds.push(created.id);
      publicListId = created.id;
    }
    app = await createZoneTestApp({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              PROMOTIONS_BUSINESS_TIMEZONE: 'America/Mexico_City',
              JWT_SECRET: TEST_JWT_SECRET,
              JWT_REFRESH_SECRET: 'backorder-showcase-refresh',
              SPACES_BUCKET: 'unused',
              SPACES_ENDPOINT: 'https://unused.invalid',
              SPACES_REGION: 'unused',
              SPACES_ACCESS_KEY_ID: 'unused',
              SPACES_SECRET_ACCESS_KEY: 'unused',
              SPACES_PUBLIC_BASE_URL: 'https://unused.invalid',
              SPACES_UPLOAD_MAX_MB: '5',
            }),
          ],
        }),
        EventEmitterModule.forRoot(),
        BackordersModule,
      ],
    });
    cls = app.get(ClsService, { strict: false });
    tenantPrisma = app.get(TenantPrismaService, { strict: false });
    writer = app.get(StockJournalWriter, { strict: false });
    reservations = app.get(BackorderReservationService, { strict: false });
  });

  afterEach(async () => {
    if (tenantIds.length > 0) {
      await prisma.backorder.deleteMany({
        where: { tenantId: { in: tenantIds } },
      });
    }
    await world.cleanup();
    if (userIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    tenantIds.length = 0;
    userIds.length = 0;
  });

  afterAll(async () => {
    await app?.close();
    if (createdPriceListIds.length > 0) {
      await prisma.globalPriceList.deleteMany({
        where: { id: { in: createdPriceListIds } },
      });
    }
    await disconnectWorldPrisma();
  });

  interface Demo {
    tenantId: string;
    slug: string;
    cashierEmail: string;
    managerEmail: string;
    managerId: string;
  }

  async function user(email: string, name: string): Promise<string> {
    const id = randomUUID();
    userIds.push(id);
    await prisma.user.create({
      data: {
        id,
        email,
        name,
        hashedPassword: 'not-a-login-hash',
        isActive: true,
      },
    });
    return id;
  }

  async function demo(): Promise<Demo> {
    const tenantId = await world.tenant('Centro demo');
    tenantIds.push(tenantId);
    const tag = randomUUID();
    const cashierEmail = `cashier-${tag}@showcase.invalid`;
    const managerEmail = `manager-${tag}@showcase.invalid`;
    await user(cashierEmail, 'Cajero demo');
    const managerId = await user(managerEmail, 'Gerente demo');
    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
    });
    return {
      tenantId,
      slug: tenant.slug,
      cashierEmail,
      managerEmail,
      managerId,
    };
  }

  const runShowcase = (d: Demo, apply = true, now = new Date()) =>
    showcase.run({
      prisma,
      now,
      apply,
      tenantSlug: d.slug,
      cashierEmail: d.cashierEmail,
      managerEmail: d.managerEmail,
    }) as Promise<{
      created: Array<{
        slug: string;
        folio: string;
        id: string;
        status: string;
        sale: string | null;
      }>;
      existing: Array<{ slug: string; folio: string; status: string }>;
      wouldCreate: Array<{ slug: string; status: string }>;
    }>;

  const inTenant = <T>(d: Demo, work: () => T): T =>
    cls.runWith(
      { tenantId: d.tenantId, userId: d.managerId, isSuperAdmin: false },
      work,
    );

  // ---------------------------------------------------------------------------

  it('dry run reads only and lists what it would create', async () => {
    const d = await demo();

    const report = await runShowcase(d, false);

    expect(report.created).toEqual([]);
    expect(report.wouldCreate.map((row) => row.slug).sort()).toEqual(
      showcase.ALL_BACKORDERS.map((spec: { slug: string }) => spec.slug).sort(),
    );
    expect(
      await prisma.backorder.count({ where: { tenantId: d.tenantId } }),
    ).toBe(0);
    expect(
      await prisma.product.count({ where: { tenantId: d.tenantId } }),
    ).toBe(0);
  });

  it('creates a backorder in every state with folios, a sale for the confirmed one, and is idempotent', async () => {
    const d = await demo();
    const now = new Date();

    const first = await runShowcase(d, true, now);

    expect(first.created).toHaveLength(7);
    expect(first.created.map((row) => row.status).sort()).toEqual([
      'CANCELLED',
      'CANCELLED',
      'CONFIRMED',
      'EXPIRED',
      'RESERVED',
      'WAITING',
      'WAITING',
    ]);
    for (const row of first.created) expect(row.folio).toMatch(/^BO-\d{6,}$/);
    expect(new Set(first.created.map((row) => row.folio)).size).toBe(7);

    const rows = await prisma.backorder.findMany({
      where: { tenantId: d.tenantId },
      include: { sale: { include: { items: true } } },
    });
    const bySlug = new Map<string, (typeof rows)[number]>(
      rows.map((row) => [
        row.idempotencyKey.replace(/^showcase:backorder:/, ''),
        row,
      ]),
    );
    // WAITING head passed over by a later reserved one.
    expect(bySlug.get('waiting-head')).toMatchObject({
      status: 'WAITING',
      passedOverCount: 1,
    });
    expect(bySlug.get('reserved')).toMatchObject({
      status: 'RESERVED',
      finalPriceCents: 45_900,
    });
    expect(bySlug.get('reserved')!.reservedUntil!.getTime()).toBeGreaterThan(
      now.getTime(),
    );
    const confirmed = bySlug.get('confirmed')!;
    expect(confirmed).toMatchObject({ status: 'CONFIRMED' });
    expect(confirmed.sale).toMatchObject({
      status: 'CONFIRMED',
      channel: 'ONLINE',
      totalCents: confirmed.finalPriceCents! * confirmed.quantity,
    });
    expect(confirmed.sale!.items[0]).toMatchObject({
      productId: confirmed.productId,
      quantity: confirmed.quantity,
      unitPriceCents: confirmed.finalPriceCents,
    });
    expect(bySlug.get('expired')).toMatchObject({
      status: 'EXPIRED',
      reservationStage: 2,
    });
    expect(bySlug.get('cancelled-customer')).toMatchObject({
      status: 'CANCELLED',
      cancelledByKind: 'CUSTOMER',
    });
    expect(bySlug.get('cancelled-staff')).toMatchObject({
      status: 'CANCELLED',
      cancelledByKind: 'STAFF',
      cancelledByUserId: d.managerId,
    });

    // Second run: nothing new, nothing changed.
    const before = await snapshot(d);
    const second = await runShowcase(d, true, new Date(now.getTime() + DAY));
    expect(second.created).toEqual([]);
    expect(second.existing).toHaveLength(7);
    expect(await snapshot(d)).toEqual(before);
  });

  async function snapshot(d: Demo) {
    return {
      backorders: await prisma.backorder.findMany({
        where: { tenantId: d.tenantId },
        orderBy: { folio: 'asc' },
      }),
      movements: await prisma.stockMovement.count({
        where: { tenantId: d.tenantId },
      }),
      products: await prisma.product.findMany({
        where: { tenantId: d.tenantId },
        orderBy: { sku: 'asc' },
      }),
      sales: await prisma.sale.count({ where: { tenantId: d.tenantId } }),
      customers: await prisma.customer.count({
        where: { tenantId: d.tenantId },
      }),
    };
  }

  it('the journal agrees with the stock and holds exactly the RESERVED units', async () => {
    const d = await demo();
    await runShowcase(d);

    const products = await prisma.product.findMany({
      where: { tenantId: d.tenantId },
    });
    expect(products).toHaveLength(3);
    for (const product of products) {
      const movements = await prisma.stockMovement.findMany({
        where: { tenantId: d.tenantId, productId: product.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      let balance = 0;
      for (const movement of movements) {
        balance += movement.delta;
        expect(movement.productBalanceAfter).toBe(balance);
        expect(movement.balanceAfter).toBe(balance);
        expect(balance).toBeGreaterThanOrEqual(0);
      }
      expect(balance).toBe(product.quantity);
      expect(product.stockVersion).toBe(movements.length);
    }
    const byName = new Map(products.map((p) => [p.sku, p.quantity]));
    expect(byName.get('DEMO-BO-GATO')).toBe(1);
    expect(byName.get('DEMO-BO-SHAMPOO')).toBe(4);
    expect(byName.get('DEMO-BO-COLLAR')).toBe(5);

    // Held units per backorder = reserves − releases: RESERVED holds its
    // quantity, CONFIRMED and EXPIRED hold nothing.
    const backorders = await prisma.backorder.findMany({
      where: { tenantId: d.tenantId },
    });
    for (const backorder of backorders) {
      const rows = await prisma.stockMovement.findMany({
        where: {
          tenantId: d.tenantId,
          groupType: 'BACKORDER',
          groupId: backorder.id,
        },
      });
      const held = 0 - rows.reduce((sum, row) => sum + row.delta, 0);
      expect(held).toBe(
        backorder.status === 'RESERVED' ? backorder.quantity : 0,
      );
    }
  });

  it('the real app reads the samples: stock fields and a valid held reservation', async () => {
    const d = await demo();
    await runShowcase(d);
    const member = await world.member(d.tenantId, 'Gerente', ['Product:read']);
    const gato = await prisma.product.findFirstOrThrow({
      where: { tenantId: d.tenantId, sku: 'DEMO-BO-GATO' },
    });
    const shampoo = await prisma.product.findFirstOrThrow({
      where: { tenantId: d.tenantId, sku: 'DEMO-BO-SHAMPOO' },
    });
    const get = (id: string) =>
      request(server())
        .get(`/products/${id}`)
        .set('Authorization', `Bearer ${member.token}`);

    expect((await get(gato.id)).body).toMatchObject({
      quantity: 1,
      availableToSell: 1,
      reservedForBackorders: 2,
      stockOnHand: 3,
    });
    // CONFIRMED / EXPIRED / WAITING / CANCELLED hold nothing.
    expect((await get(shampoo.id)).body).toMatchObject({
      quantity: 4,
      reservedForBackorders: 0,
      stockOnHand: 4,
    });

    const reserved = await prisma.backorder.findFirstOrThrow({
      where: {
        tenantId: d.tenantId,
        idempotencyKey: 'showcase:backorder:reserved',
      },
    });
    const outcome = await inTenant(d, () =>
      tenantPrisma.runInTransaction(() =>
        reservations.revalidateReservation(
          tenantPrisma.getClient(),
          reserved.id,
        ),
      ),
    );
    expect(outcome).toEqual({ outcome: 'VALID' });
  });

  it('writes journal rows shaped exactly like the real allocator and releaseBackorder', async () => {
    // Real flow in a second tenant: a WAITING backorder, stock arrives, the
    // allocator reserves; then the reservation is released.
    const real = await demo();
    const productId = randomUUID();
    await prisma.product.create({
      data: {
        id: productId,
        tenantId: real.tenantId,
        name: 'Producto real',
        useStock: true,
        quantity: 0,
      },
    });
    await prisma.priceList.create({
      data: {
        tenantId: real.tenantId,
        productId,
        globalPriceListId: publicListId,
        priceCents: 1000,
      },
    });
    const customerId = randomUUID();
    await prisma.customer.create({
      data: { id: customerId, tenantId: real.tenantId, firstName: 'Real' },
    });
    const decision = await prisma.humanDecision.create({
      data: {
        tenantId: real.tenantId,
        source: 'houndfe-chatbot',
        sourceRequestId: randomUUID(),
        type: 'RESTOCK',
        canonicalRequestHash: 'h'.repeat(64),
        submittedCredentialId: 'cred',
        branchId: real.tenantId,
        branchName: 'Centro',
        productId,
        productName: 'Producto real',
        variantId: null,
        status: 'RESOLVED',
        version: 2,
        resolutionAction: 'PROVIDE_RESTOCK_ESTIMATE',
        restockDays: 7,
        resolutionRequestId: randomUUID(),
        resolvedAt: new Date(Date.now() - DAY),
        resolvedByActorId: 'actor',
        resolvedByDisplayName: 'Gerente',
      },
    });
    const waiting = await prisma.backorder.create({
      data: {
        tenantId: real.tenantId,
        folio: 'BO-990001',
        customerId,
        productId,
        quantity: 2,
        referencePriceCents: 1000,
        scheduledAt: new Date(Date.now() - DAY),
        estimatedArrivalDays: 7,
        estimatedAt: new Date(Date.now() + DAY),
        sourceDecisionId: decision.id,
        idempotencyKey: randomUUID(),
        requestHash: 'a'.repeat(64),
      },
    });
    const system = { id: null, displayName: 'Sistema' };
    await inTenant(real, () =>
      tenantPrisma.runInTransaction(async () => {
        await writer.apply(
          [
            {
              bucket: { kind: 'PRODUCT_UNTRACKED', productId },
              delta: 3,
            },
          ],
          {
            type: 'INITIAL',
            groupType: 'PRODUCT',
            groupId: productId,
            actor: system,
          },
        );
        // Released like an expiry: no allocation of the freed units.
        await writer.releaseBackorder({
          backorderId: waiting.id,
          actor: system,
          allocate: false,
        });
      }),
    );
    const realRows = await prisma.stockMovement.findMany({
      where: { tenantId: real.tenantId, groupId: waiting.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(realRows.map((row) => row.type)).toEqual([
      'BACKORDER_RESERVE',
      'BACKORDER_RELEASE',
    ]);

    // Showcase: the EXPIRED sample is reserve + release by the system.
    const d = await demo();
    await runShowcase(d);
    const expired = await prisma.backorder.findFirstOrThrow({
      where: {
        tenantId: d.tenantId,
        idempotencyKey: 'showcase:backorder:expired',
      },
    });
    const sampleRows = await prisma.stockMovement.findMany({
      where: { tenantId: d.tenantId, groupId: expired.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    const shape = (row: (typeof realRows)[number]) => ({
      bucketKind: row.bucketKind,
      type: row.type,
      groupType: row.groupType,
      variantId: row.variantId,
      lotId: row.lotId,
      variantLabel: row.variantLabel,
      lotNumber: row.lotNumber,
      reason: row.reason,
      note: row.note,
      removalCause: row.removalCause,
      actorId: row.actorId,
      actorDisplayName: row.actorDisplayName,
      deltaSign: Math.sign(row.delta),
    });
    expect(sampleRows.map(shape)).toEqual(realRows.map(shape));
  });
});
