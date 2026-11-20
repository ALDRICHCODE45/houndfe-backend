/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- supertest bodies are untyped JSON */
/**
 * restock-backorder / T5b (S1 §3 §4 §9.4; frontend L2, L8, L13) against REAL
 * PostgreSQL with the real JWT → tenant → CASL guard chain and the production
 * routes:
 *
 *  - stock fields `stockOnHand` / `reservedForBackorders` / `availableToSell` on
 *    GET /products, GET /products/:id, GET /products/:id/variants and the POS
 *    catalog (GET /sales/pos-catalog[/:id]): values (only RESERVED backorders
 *    of the caller's tenant count) and ONE batched backorder read per response;
 *  - the variant block: POST /products/:id/variants and
 *    PATCH /products/:id {hasVariants:true} answer 409
 *    PRODUCT_HAS_ACTIVE_BACKORDERS while a WAITING/RESERVED product-level
 *    backorder exists, change nothing, and products without active backorders
 *    still get variants;
 *  - POS add-item warning and the counter confirm
 *    POST /sales/drafts/:id/charge → 409 STOCK_RESERVED_FOR_BACKORDER vs the
 *    plain STOCK_INSUFFICIENT_AT_CONFIRM.
 */
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import request from 'supertest';
import type { App } from 'supertest/types';
import { BackordersBotService } from '../backorders/application/backorders-bot.service';
import { BackordersModule } from '../backorders/backorders.module';
import { BackorderError } from '../backorders/domain/backorder-error';
import {
  createZoneTestApp,
  disconnectWorldPrisma,
  SKIP_DB_INTEGRATION,
  TEST_JWT_SECRET,
  worldPrisma,
  ZoneWorld,
  type SeededMember,
} from '../delivery-zones/test-support/delivery-zone-world';
import * as reservedStock from '../inventory/infrastructure/backorder-reserved-stock';

const describeIfDb = SKIP_DB_INTEGRATION ? describe.skip : describe;
const DAY = 86_400_000;
const GRANTS = [
  'Product:read',
  'Product:update',
  'Product:delete',
  'Sale:read',
  'Sale:create',
  'Sale:update',
];

describeIfDb('restock backorder stock fields and guards (PostgreSQL)', () => {
  const prisma = worldPrisma();
  const world = new ZoneWorld();
  const createdPriceListIds: string[] = [];
  let app: INestApplication;
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
        data: { name: `PUBLICO-t5b-${randomUUID()}`, isDefault: true },
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
              JWT_REFRESH_SECRET: 'products-backorder-stock-refresh',
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
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await world.cleanup();
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

  // ---------------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------------

  interface Tenant {
    tenantId: string;
    member: SeededMember;
    decisionId: string;
    customers: string[];
  }

  async function tenant(name: string): Promise<Tenant> {
    const tenantId = await world.tenant(name);
    const member = await world.member(tenantId, `Gerente ${name}`, GRANTS);
    const customers: string[] = [];
    for (let n = 0; n < 8; n++) {
      const id = randomUUID();
      await prisma.customer.create({
        data: { id, tenantId, firstName: `Cliente${n}` },
      });
      customers.push(id);
    }
    const productForDecision = randomUUID();
    await prisma.product.create({
      data: { id: productForDecision, tenantId, name: 'Referencia' },
    });
    const decision = await prisma.humanDecision.create({
      data: {
        tenantId,
        source: 'houndfe-chatbot',
        sourceRequestId: randomUUID(),
        type: 'RESTOCK',
        canonicalRequestHash: 'h'.repeat(64),
        submittedCredentialId: 'cred',
        branchId: tenantId,
        branchName: 'Centro',
        productId: productForDecision,
        productName: 'Referencia',
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
    return { tenantId, member, decisionId: decision.id, customers };
  }

  async function product(
    t: Tenant,
    options: {
      name?: string;
      quantity?: number;
      priceCents?: number;
      variants?: Array<{ name: string; quantity: number }>;
    } = {},
  ): Promise<{ id: string; variantIds: string[] }> {
    const id = randomUUID();
    const variants = options.variants ?? [];
    await prisma.product.create({
      data: {
        id,
        tenantId: t.tenantId,
        name: options.name ?? 'Croquetas',
        useStock: true,
        quantity: options.quantity ?? 0,
        hasVariants: variants.length > 0,
      },
    });
    const priceList = await prisma.priceList.create({
      data: {
        tenantId: t.tenantId,
        productId: id,
        globalPriceListId: publicListId,
        priceCents: options.priceCents ?? 1000,
      },
    });
    const variantIds: string[] = [];
    for (const variant of variants) {
      const variantId = randomUUID();
      await prisma.variant.create({
        data: {
          id: variantId,
          tenantId: t.tenantId,
          productId: id,
          name: variant.name,
          quantity: variant.quantity,
        },
      });
      await prisma.variantPrice.create({
        data: {
          tenantId: t.tenantId,
          variantId,
          priceListId: priceList.id,
          priceCents: options.priceCents ?? 1000,
        },
      });
      variantIds.push(variantId);
    }
    return { id, variantIds };
  }

  let seq = 0;
  async function backorder(
    t: Tenant,
    productId: string,
    over: Partial<Prisma.BackorderUncheckedCreateInput> & {
      customerIndex: number;
    },
  ) {
    seq += 1;
    const { customerIndex, ...rest } = over;
    const status = rest.status ?? 'WAITING';
    const lifecycle: Partial<Prisma.BackorderUncheckedCreateInput> =
      status === 'RESERVED'
        ? {
            reservedAt: new Date(),
            reservedUntil: new Date(Date.now() + DAY),
            reminderAt: new Date(Date.now() + DAY - 3 * 3_600_000),
            currentPriceCents: 1000,
            finalPriceCents: 1000,
          }
        : status === 'CANCELLED'
          ? { cancelledAt: new Date(), cancelledByKind: 'CUSTOMER' }
          : status === 'EXPIRED'
            ? { expiredAt: new Date() }
            : {};
    return prisma.backorder.create({
      data: {
        tenantId: t.tenantId,
        folio: `BO-${String(900000 + seq)}`,
        customerId: t.customers[customerIndex],
        productId,
        quantity: 1,
        referencePriceCents: 1000,
        scheduledAt: new Date(Date.now() - seq * 1000),
        estimatedArrivalDays: 7,
        estimatedAt: new Date(Date.now() + 7 * DAY),
        sourceDecisionId: t.decisionId,
        idempotencyKey: randomUUID(),
        requestHash: 'a'.repeat(64),
        ...lifecycle,
        ...rest,
      },
    });
  }

  const get = (t: Tenant, path: string) =>
    request(server())
      .get(path)
      .set('Authorization', `Bearer ${t.member.token}`);
  const send = (
    t: Tenant,
    method: 'post' | 'patch',
    path: string,
    body: Record<string, unknown> = {},
  ) =>
    request(server())
      [method](path)
      .set('Authorization', `Bearer ${t.member.token}`)
      .send(body);

  // ---------------------------------------------------------------------------
  // Stock fields
  // ---------------------------------------------------------------------------

  describe('stock fields on the POS-used reads', () => {
    async function scene() {
      const t = await tenant('Centro');
      const plain = await product(t, {
        name: 'Croquetas Plain',
        quantity: 5,
      });
      const withVariants = await product(t, {
        name: 'Camisa',
        variants: [
          { name: 'Chica', quantity: 3 },
          { name: 'Grande', quantity: 4 },
        ],
      });
      // Plain product: 2 + 1 RESERVED count, WAITING/CANCELLED/EXPIRED do not.
      await backorder(t, plain.id, {
        customerIndex: 0,
        status: 'RESERVED',
        quantity: 2,
      });
      await backorder(t, plain.id, {
        customerIndex: 1,
        status: 'RESERVED',
        quantity: 1,
      });
      await backorder(t, plain.id, {
        customerIndex: 2,
        status: 'WAITING',
        quantity: 7,
      });
      await backorder(t, plain.id, {
        customerIndex: 3,
        status: 'CANCELLED',
        quantity: 9,
      });
      await backorder(t, plain.id, {
        customerIndex: 4,
        status: 'EXPIRED',
        quantity: 9,
      });
      // Variant product: only the Grande variant holds a reservation.
      await backorder(t, withVariants.id, {
        customerIndex: 0,
        variantId: withVariants.variantIds[1],
        status: 'RESERVED',
        quantity: 6,
      });
      // Another tenant's reservation never leaks in.
      const other = await tenant('Otra sucursal');
      const foreign = await product(other, { quantity: 5 });
      await backorder(other, foreign.id, {
        customerIndex: 0,
        status: 'RESERVED',
        quantity: 4,
      });
      return { t, plain, withVariants };
    }

    it('GET /products: product level of every product, from ONE backorder read', async () => {
      const { t, plain, withVariants } = await scene();
      const spy = jest.spyOn(reservedStock, 'loadReservedStock');

      const response = await get(t, '/products?search=');

      expect(response.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
      const byId = new Map<string, any>(
        response.body.map((row: { id: string }) => [row.id, row]),
      );
      expect(byId.get(plain.id)).toMatchObject({
        quantity: 5,
        stockOnHand: 8,
        reservedForBackorders: 3,
        availableToSell: 5,
      });
      expect(byId.get(withVariants.id)).toMatchObject({
        quantity: 0,
        variantStockTotal: 7,
        stockOnHand: 13,
        reservedForBackorders: 6,
        availableToSell: 7,
      });
    });

    it('GET /products/:id: product level and each variant (one read)', async () => {
      const { t, plain, withVariants } = await scene();
      const spy = jest.spyOn(reservedStock, 'loadReservedStock');

      const plainBody = (await get(t, `/products/${plain.id}`)).body;
      expect(plainBody).toMatchObject({
        quantity: 5,
        stockOnHand: 8,
        reservedForBackorders: 3,
        availableToSell: 5,
      });
      expect(spy).toHaveBeenCalledTimes(1);

      spy.mockClear();
      const variantBody = (await get(t, `/products/${withVariants.id}`)).body;
      expect(spy).toHaveBeenCalledTimes(1);
      expect(variantBody).toMatchObject({
        stockOnHand: 13,
        reservedForBackorders: 6,
        availableToSell: 7,
      });
      const byName = new Map<string, any>(
        variantBody.variants.map((v: { name: string }) => [v.name, v]),
      );
      expect(byName.get('Chica')).toMatchObject({
        quantity: 3,
        stockOnHand: 3,
        reservedForBackorders: 0,
        availableToSell: 3,
      });
      expect(byName.get('Grande')).toMatchObject({
        quantity: 4,
        stockOnHand: 10,
        reservedForBackorders: 6,
        availableToSell: 4,
      });
    });

    it('GET /products/:id/variants: every variant, one read', async () => {
      const { t, withVariants } = await scene();
      const spy = jest.spyOn(reservedStock, 'loadReservedStock');

      const response = await get(t, `/products/${withVariants.id}/variants`);

      expect(response.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
      const byName = new Map<string, any>(
        response.body.map((v: { name: string }) => [v.name, v]),
      );
      expect(byName.get('Chica')).toMatchObject({
        availableToSell: 3,
        reservedForBackorders: 0,
        stockOnHand: 3,
      });
      expect(byName.get('Grande')).toMatchObject({
        availableToSell: 4,
        reservedForBackorders: 6,
        stockOnHand: 10,
      });
    });

    it('GET /sales/pos-catalog and /sales/pos-catalog/:productId: inside each stock object, one read per response', async () => {
      const { t, plain, withVariants } = await scene();
      const spy = jest.spyOn(reservedStock, 'loadReservedStock');

      const search = await get(t, '/sales/pos-catalog');
      expect(search.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
      const items = new Map<string, any>(
        search.body.items.map((item: { id: string }) => [item.id, item]),
      );
      expect(items.get(plain.id).stock).toEqual({
        quantity: 5,
        minQuantity: 0,
        location: null,
        stockOnHand: 8,
        reservedForBackorders: 3,
        availableToSell: 5,
      });
      expect(items.get(withVariants.id).stock).toBeNull();
      const grande = items
        .get(withVariants.id)
        .variants.find((v: { name: string }) => v.name === 'Grande');
      expect(grande.stock).toMatchObject({
        quantity: 4,
        stockOnHand: 10,
        reservedForBackorders: 6,
        availableToSell: 4,
      });

      spy.mockClear();
      const detail = await get(t, `/sales/pos-catalog/${plain.id}`);
      expect(detail.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(detail.body.stock).toMatchObject({
        stockOnHand: 8,
        reservedForBackorders: 3,
        availableToSell: 5,
      });
    });

    it('a page of many products runs ONE grouped read, not one per product', async () => {
      const t = await tenant('Centro');
      const ids: string[] = [];
      for (let n = 0; n < 12; n++) {
        const created = await product(t, {
          name: `Producto ${n}`,
          quantity: n,
          variants:
            n % 3 === 0
              ? [
                  { name: 'A', quantity: 1 },
                  { name: 'B', quantity: 2 },
                ]
              : [],
        });
        ids.push(created.id);
      }
      await backorder(t, ids[1], {
        customerIndex: 0,
        status: 'RESERVED',
        quantity: 2,
      });
      const spy = jest.spyOn(reservedStock, 'loadReservedStock');

      const list = await get(t, '/products?limit=50');
      const pos = await get(t, '/sales/pos-catalog?limit=50');

      // 12 products + the decision's reference product of the fixture.
      expect(list.body).toHaveLength(13);
      expect(pos.body.items).toHaveLength(13);
      expect(spy).toHaveBeenCalledTimes(2); // once per response
      const reservedOne = list.body.find((row: any) => row.id === ids[1]);
      expect(reservedOne).toMatchObject({
        quantity: 1,
        stockOnHand: 3,
        reservedForBackorders: 2,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Variant block
  // ---------------------------------------------------------------------------

  describe('variant block (PRODUCT_HAS_ACTIVE_BACKORDERS)', () => {
    const blockedBody = {
      statusCode: 409,
      error: 'PRODUCT_HAS_ACTIVE_BACKORDERS',
      message: 'El producto tiene pedidos por reposición activos',
      timestamp: expect.any(String),
    };

    it.each(['WAITING', 'RESERVED'] as const)(
      'POST /products/:id/variants with a %s product-level backorder → 409, nothing changed',
      async (status) => {
        const t = await tenant('Centro');
        const p = await product(t, { quantity: 5 });
        await backorder(t, p.id, { customerIndex: 0, status, quantity: 2 });

        const response = await send(t, 'post', `/products/${p.id}/variants`, {
          name: 'Rojo',
          quantity: 3,
        });

        expect(response.status).toBe(409);
        expect(response.body).toEqual(blockedBody);
        const after = await prisma.product.findUniqueOrThrow({
          where: { id: p.id },
        });
        expect(after).toMatchObject({ hasVariants: false, quantity: 5 });
        expect(await prisma.variant.count({ where: { productId: p.id } })).toBe(
          0,
        );
        expect(
          await prisma.stockMovement.count({ where: { productId: p.id } }),
        ).toBe(0);
      },
    );

    it('PATCH /products/:id {hasVariants:true} with an active backorder → same 409, stock untouched', async () => {
      const t = await tenant('Centro');
      const p = await product(t, { quantity: 5 });
      await backorder(t, p.id, {
        customerIndex: 0,
        status: 'RESERVED',
        quantity: 2,
      });

      const response = await send(t, 'patch', `/products/${p.id}`, {
        hasVariants: true,
      });

      expect(response.status).toBe(409);
      expect(response.body).toEqual(blockedBody);
      expect(
        await prisma.product.findUniqueOrThrow({ where: { id: p.id } }),
      ).toMatchObject({ hasVariants: false, quantity: 5 });
      expect(
        await prisma.stockMovement.count({ where: { productId: p.id } }),
      ).toBe(0);
    });

    it('products without active backorders still get variants (none, terminal only, or only another product)', async () => {
      const t = await tenant('Centro');
      const clean = await product(t, { name: 'Limpio', quantity: 5 });
      const terminal = await product(t, { name: 'Terminal', quantity: 5 });
      const other = await product(t, { name: 'Con pedido', quantity: 5 });
      await backorder(t, terminal.id, {
        customerIndex: 0,
        status: 'CANCELLED',
      });
      await backorder(t, terminal.id, {
        customerIndex: 1,
        status: 'EXPIRED',
      });
      await backorder(t, other.id, { customerIndex: 0, status: 'WAITING' });

      for (const p of [clean, terminal]) {
        const response = await send(t, 'post', `/products/${p.id}/variants`, {
          name: 'Rojo',
          quantity: 2,
        });
        expect(response.status).toBe(201);
        expect(
          await prisma.product.findUniqueOrThrow({ where: { id: p.id } }),
        ).toMatchObject({ hasVariants: true, quantity: 0 });
      }

      const converted = await send(t, 'patch', `/products/${clean.id}`, {
        name: 'Limpio 2',
      });
      expect(converted.status).toBe(200);
    });

    it('PATCH {hasVariants:true} without active backorders still works', async () => {
      const t = await tenant('Centro');
      const p = await product(t, { quantity: 5 });
      await backorder(t, p.id, { customerIndex: 0, status: 'CANCELLED' });

      const response = await send(t, 'patch', `/products/${p.id}`, {
        hasVariants: true,
      });

      expect(response.status).toBe(200);
      expect(response.body.hasVariants).toBe(true);
    });

    it('once the active backorder is cancelled the first variant can be added', async () => {
      const t = await tenant('Centro');
      const p = await product(t, { quantity: 5 });
      const active = await backorder(t, p.id, {
        customerIndex: 0,
        status: 'WAITING',
      });
      expect(
        (await send(t, 'post', `/products/${p.id}/variants`, { name: 'Rojo' }))
          .status,
      ).toBe(409);

      await prisma.backorder.update({
        where: { id: active.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledByKind: 'STAFF',
        },
      });

      expect(
        (await send(t, 'post', `/products/${p.id}/variants`, { name: 'Rojo' }))
          .status,
      ).toBe(201);
    });
  });

  // ---------------------------------------------------------------------------
  // POS add-item warning + counter confirm
  // ---------------------------------------------------------------------------

  describe('counter sale vs reservation', () => {
    /** shelf `quantity` units, `reserved` units held by one RESERVED backorder. */
    async function reservedProduct(shelf: number, reserved: number) {
      const t = await tenant('Centro');
      const p = await product(t, {
        quantity: shelf,
        priceCents: 1000,
      });
      if (reserved > 0) {
        await backorder(t, p.id, {
          customerIndex: 0,
          status: 'RESERVED',
          quantity: reserved,
        });
      }
      const draft = await send(t, 'post', '/sales/drafts');
      expect(draft.status).toBe(201);
      return { t, p, saleId: draft.body.id as string };
    }

    const addItem = (
      t: Tenant,
      saleId: string,
      productId: string,
      quantity: number,
    ) =>
      send(t, 'post', `/sales/drafts/${saleId}/items`, { productId, quantity });

    const charge = (
      t: Tenant,
      saleId: string,
      totalCents: number,
      key: string,
    ) =>
      request(server())
        .post(`/sales/drafts/${saleId}/charge`)
        .set('Authorization', `Bearer ${t.member.token}`)
        .set('Idempotency-Key', key)
        .send({ method: 'cash', amountCents: totalCents });

    it('add-item: a quantity above availableToSell but within stockOnHand is added with a non-blocking stockWarning on that line', async () => {
      const { t, p, saleId } = await reservedProduct(2, 3);

      const response = await addItem(t, saleId, p.id, 4);

      expect(response.status).toBe(200);
      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0]).toMatchObject({
        productId: p.id,
        quantity: 4,
        stockWarning: {
          code: 'STOCK_RESERVED_FOR_BACKORDER',
          available: 2,
          reserved: 3,
        },
      });
    });

    it('add-item: above stockOnHand is refused exactly as before, and a covered quantity carries no warning', async () => {
      const { t, p, saleId } = await reservedProduct(2, 3);

      const tooMany = await addItem(t, saleId, p.id, 6);
      expect(tooMany.status).toBe(422);
      expect(tooMany.body.message).toMatch(/Insufficient stock/);

      const covered = await addItem(t, saleId, p.id, 2);
      expect(covered.status).toBe(200);
      expect(covered.body.items[0]).not.toHaveProperty('stockWarning');
    });

    it('add-item: with nothing reserved the refusal is unchanged', async () => {
      const { t, p, saleId } = await reservedProduct(2, 0);

      const response = await addItem(t, saleId, p.id, 3);

      expect(response.status).toBe(422);
      expect(response.body.message).toMatch(/Insufficient stock/);
    });

    it('confirm: 409 STOCK_RESERVED_FOR_BACKORDER {available, reserved}; nothing sold, draft intact', async () => {
      const { t, p, saleId } = await reservedProduct(2, 3);
      expect((await addItem(t, saleId, p.id, 4)).status).toBe(200);

      const response = await charge(t, saleId, 4000, 'reserved-1');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        statusCode: 409,
        error: 'STOCK_RESERVED_FOR_BACKORDER',
        message: 'STOCK_RESERVED_FOR_BACKORDER',
        timestamp: expect.any(String),
        available: 2,
        reserved: 3,
      });
      expect(
        await prisma.product.findUniqueOrThrow({ where: { id: p.id } }),
      ).toMatchObject({ quantity: 2 });
      expect(
        await prisma.sale.findUniqueOrThrow({ where: { id: saleId } }),
      ).toMatchObject({ status: 'DRAFT' });
      expect(
        await prisma.stockMovement.count({ where: { productId: p.id } }),
      ).toBe(0);
    });

    it('confirm: plain insufficient stock keeps the existing STOCK_INSUFFICIENT_AT_CONFIRM body', async () => {
      const { t, p, saleId } = await reservedProduct(5, 0);
      expect((await addItem(t, saleId, p.id, 4)).status).toBe(200);
      // Someone else sold the shelf in the meantime.
      await prisma.product.update({
        where: { id: p.id },
        data: { quantity: 1 },
      });

      const response = await charge(t, saleId, 4000, 'plain-1');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        statusCode: 409,
        error: 'STOCK_INSUFFICIENT_AT_CONFIRM',
        message: 'STOCK_INSUFFICIENT_AT_CONFIRM',
        timestamp: expect.any(String),
      });
    });

    it('confirm: reserved units that would not cover the line stay a plain STOCK_INSUFFICIENT_AT_CONFIRM', async () => {
      const { t, p, saleId } = await reservedProduct(5, 2);
      expect((await addItem(t, saleId, p.id, 4)).status).toBe(200);
      await prisma.product.update({
        where: { id: p.id },
        data: { quantity: 0 }, // 0 + 2 reserved < 4
      });

      const response = await charge(t, saleId, 4000, 'plain-2');

      expect(response.status).toBe(409);
      expect(response.body.error).toBe('STOCK_INSUFFICIENT_AT_CONFIRM');
      expect(response.body).not.toHaveProperty('reserved');
    });

    it('confirm: a quantity inside availableToSell sells normally even with reserved units around', async () => {
      const { t, p, saleId } = await reservedProduct(2, 3);
      expect((await addItem(t, saleId, p.id, 2)).status).toBe(200);

      const response = await charge(t, saleId, 2000, 'ok-1');

      expect(response.status).toBe(201);
      expect(
        await prisma.product.findUniqueOrThrow({ where: { id: p.id } }),
      ).toMatchObject({ quantity: 0 });
    });
  });

  // ---------------------------------------------------------------------------
  // T8(a): bot schedule vs product conversion (lock order)
  // ---------------------------------------------------------------------------

  describe('bot schedule vs conversion to variants (T8 a)', () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let phoneSeq = 0;

    async function restockDecision(t: Tenant, productId: string) {
      const decision = await prisma.humanDecision.create({
        data: {
          tenantId: t.tenantId,
          source: 'houndfe-chatbot',
          sourceRequestId: randomUUID(),
          type: 'RESTOCK',
          canonicalRequestHash: 'h'.repeat(64),
          submittedCredentialId: 'cred',
          branchId: t.tenantId,
          branchName: 'Centro',
          productId,
          productName: 'Croquetas',
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
      return decision.id;
    }

    /** The bot schedule of a product-level backorder (no variantId). */
    function schedule(t: Tenant, productId: string, decisionId: string) {
      phoneSeq += 1;
      const cls = app.get(ClsService, { strict: false });
      const bot = app.get(BackordersBotService, { strict: false });
      return cls.runWith(
        { tenantId: t.tenantId, userId: '', isSuperAdmin: false },
        () =>
          bot.create(
            {
              phoneCountryCode: '52',
              phone: `55${String(8000000 + phoneSeq)}`,
              customer: { mode: 'createIfAbsent', firstName: 'Rosa' },
              productId,
              quantity: 2,
              sourceDecisionId: decisionId,
            },
            randomUUID(),
          ),
      );
    }

    const isDeadlock = (r: PromiseSettledResult<unknown>) =>
      r.status === 'rejected' &&
      /deadlock|40P01/i.test(
        String((r.reason as Error)?.message ?? (r.reason as string)),
      );

    it('a conversion committed while the schedule waits for the product row: VARIANT_REQUIRED, no product-level backorder', async () => {
      const t = await tenant('Centro');
      const p = await product(t, { quantity: 0 });
      const decisionId = await restockDecision(t, p.id);

      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const lockedSignal = new Promise<void>((resolve) => (locked = resolve));
      // A conversion in flight: holds the product row FOR UPDATE, commits later.
      const conversion = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "products" WHERE "id" = ${p.id} FOR UPDATE`;
          locked();
          await gate;
          await tx.variant.create({
            data: {
              tenantId: t.tenantId,
              productId: p.id,
              name: 'Rojo',
              quantity: 0,
            },
          });
          await tx.product.update({
            where: { id: p.id },
            data: { hasVariants: true },
          });
        },
        { timeout: 20_000 },
      );
      await lockedSignal;

      const scheduled = schedule(t, p.id, decisionId).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await sleep(500); // the schedule is now past (or waiting at) its product read
      release();
      await conversion;
      const outcome = await scheduled;

      expect(outcome).toHaveProperty('error');
      const { error } = outcome as { error: BackorderError };
      expect(error).toBeInstanceOf(BackorderError);
      expect(error.code).toBe('VARIANT_REQUIRED');
      expect(await prisma.backorder.count({ where: { productId: p.id } })).toBe(
        0,
      );
    });

    it('schedule vs POST /products/:id/variants, many interleavings: never a product-level backorder on a product with variants, no deadlock', async () => {
      const t = await tenant('Centro');
      const delays = [0, 0, 1, 2, 3, 5, 8, 12, 18, 25, 35, 50];
      const wins = { scheduled: 0, converted: 0 };
      for (let round = 0; round < 24; round++) {
        const p = await product(t, { quantity: 0 });
        const decisionId = await restockDecision(t, p.id);
        const delay = delays[round % delays.length];
        const botFirst = round % 2 === 0;

        const results = await Promise.allSettled([
          sleep(botFirst ? 0 : delay).then(() => schedule(t, p.id, decisionId)),
          sleep(botFirst ? delay : 0).then(() =>
            send(t, 'post', `/products/${p.id}/variants`, { name: 'Rojo' }),
          ),
        ]);

        expect(results.filter(isDeadlock)).toEqual([]);
        const [bot, conversion] = results;
        const converted =
          conversion.status === 'fulfilled' && conversion.value.status === 201;
        if (bot.status === 'rejected') {
          expect((bot.reason as BackorderError).code).toBe('VARIANT_REQUIRED');
          expect(converted).toBe(true);
        } else {
          expect(converted).toBe(false);
          expect(
            (conversion as PromiseFulfilledResult<request.Response>).value.body
              .error,
          ).toBe('PRODUCT_HAS_ACTIVE_BACKORDERS');
        }
        const stored = await prisma.product.findUniqueOrThrow({
          where: { id: p.id },
        });
        const productLevel = await prisma.backorder.count({
          where: { productId: p.id, variantId: null },
        });
        expect(stored.hasVariants && productLevel > 0).toBe(false);
        wins[bot.status === 'fulfilled' ? 'scheduled' : 'converted'] += 1;
      }
      expect(wins.scheduled + wins.converted).toBe(24);
      // Evidence of the interleavings that happened (read in the test output).
      console.log(`schedule-vs-conversion outcomes: ${JSON.stringify(wins)}`);
    });
  });

  // ---------------------------------------------------------------------------
  // T8(b): variant delete with backorders
  // ---------------------------------------------------------------------------

  describe('DELETE /products/:id/variants/:variantId with backorders (VARIANT_HAS_BACKORDERS)', () => {
    const remove = (t: Tenant, productId: string, variantId: string) =>
      request(server())
        .delete(`/products/${productId}/variants/${variantId}`)
        .set('Authorization', `Bearer ${t.member.token}`);

    it.each([
      'WAITING',
      'RESERVED',
      'EXPIRED',
      'CANCELLED',
      'CONFIRMED',
    ] as const)(
      'a %s backorder of the variant → 409 VARIANT_HAS_BACKORDERS, nothing changes',
      async (status) => {
        const t = await tenant('Centro');
        const p = await product(t, {
          variants: [
            { name: 'Rojo', quantity: 4 },
            { name: 'Azul', quantity: 1 },
          ],
        });
        const extra: Partial<Prisma.BackorderUncheckedCreateInput> = {};
        if (status === 'CONFIRMED') {
          const sale = await prisma.sale.create({
            data: {
              tenantId: t.tenantId,
              userId: t.member.userId,
              status: 'CONFIRMED',
              channel: 'POS',
              deliveryStatus: 'PENDING',
              paymentStatus: 'CREDIT',
              folio: `V-${randomUUID().slice(0, 8)}`,
              confirmedAt: new Date(),
              subtotalCents: 1000,
              totalCents: 1000,
              debtCents: 1000,
            },
          });
          Object.assign(extra, {
            saleId: sale.id,
            confirmedAt: new Date(),
            reservedAt: new Date(),
            reservedUntil: new Date(Date.now() + DAY),
            reminderAt: new Date(Date.now() + DAY - 3 * 3_600_000),
            currentPriceCents: 1000,
            finalPriceCents: 1000,
          });
        }
        await backorder(t, p.id, {
          customerIndex: 0,
          status,
          variantId: p.variantIds[0],
          ...extra,
        });

        const response = await remove(t, p.id, p.variantIds[0]);

        expect(response.status).toBe(409);
        expect(response.body).toEqual({
          statusCode: 409,
          error: 'VARIANT_HAS_BACKORDERS',
          message: 'La variante tiene pedidos por reposición',
          timestamp: expect.any(String),
        });
        expect(await prisma.variant.count({ where: { productId: p.id } })).toBe(
          2,
        );
        expect(
          await prisma.variant.findUniqueOrThrow({
            where: { id: p.variantIds[0] },
          }),
        ).toMatchObject({ quantity: 4 });
        expect(
          await prisma.stockMovement.count({ where: { productId: p.id } }),
        ).toBe(0);
        expect(
          await prisma.product.findUniqueOrThrow({ where: { id: p.id } }),
        ).toMatchObject({ hasVariants: true });
      },
    );

    it('a variant without backorders deletes exactly as before (another variant has them); the last one clears hasVariants', async () => {
      const t = await tenant('Centro');
      const p = await product(t, {
        variants: [
          { name: 'Rojo', quantity: 0 },
          { name: 'Azul', quantity: 0 },
        ],
      });
      await backorder(t, p.id, {
        customerIndex: 0,
        status: 'WAITING',
        variantId: p.variantIds[0],
      });

      const free = await remove(t, p.id, p.variantIds[1]);

      expect(free.status).toBe(204);
      expect(
        await prisma.variant.findMany({ where: { productId: p.id } }),
      ).toEqual([expect.objectContaining({ id: p.variantIds[0] })]);
      expect(
        await prisma.product.findUniqueOrThrow({ where: { id: p.id } }),
      ).toMatchObject({ hasVariants: true });

      const q = await product(t, {
        variants: [{ name: 'Verde', quantity: 0 }],
      });
      expect((await remove(t, q.id, q.variantIds[0])).status).toBe(204);
      expect(
        await prisma.product.findUniqueOrThrow({ where: { id: q.id } }),
      ).toMatchObject({ hasVariants: false });
    });
  });
});
