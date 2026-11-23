/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/require-await -- supertest bodies are untyped JSON; test doubles are async-shaped */
/**
 * customer-pets / T3 — one lock order for POS draft writes and customer DELETE:
 * sales row → pets (FOR SHARE) → sale_items rows, and for DELETE: customer →
 * the customer's sale rows → its pets → (cascades).
 *
 * Deterministic handshake, no sleeps: a helper transaction holds ONE row lock,
 * the first request is started and we wait until `pg_blocking_pids` shows it
 * blocked on the helper, the second request is started and we wait until it is
 * blocked too, then the helper releases. Both must complete (no 40P01) in
 * either start order.
 */
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  createZoneTestApp,
  disconnectWorldPrisma,
  SKIP_DB_INTEGRATION,
  worldPrisma,
  ZoneWorld,
  type SeededMember,
} from '../delivery-zones/test-support/delivery-zone-world';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import { PrismaSaleRepository } from '../sales/infrastructure/prisma-sale.repository';
import { SalesController } from '../sales/sales.controller';
import { SalesService } from '../sales/sales.service';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { CUSTOMER_REPOSITORY } from './domain/customer.repository';
import { PrismaCustomerRepository } from './infrastructure/prisma-customer.repository';

const describeIfDb = SKIP_DB_INTEGRATION ? describe.skip : describe;

describeIfDb(
  'customer DELETE vs POS draft writes with pets (PostgreSQL)',
  () => {
    const prisma = worldPrisma();
    const world = new ZoneWorld();
    let app: INestApplication;
    const server = () => app.getHttpServer() as App;

    beforeAll(async () => {
      app = await createZoneTestApp({
        controllers: [SalesController, CustomersController],
        providers: [
          CustomersService,
          { provide: CUSTOMER_REPOSITORY, useClass: PrismaCustomerRepository },
          {
            provide: SalesService,
            inject: [TenantPrismaService],
            useFactory: (tenantPrisma: TenantPrismaService) => {
              // SAFETY: the methods under test only use the ports installed below.
              const sales = Object.create(
                SalesService.prototype,
              ) as SalesService;
              Object.assign(sales, {
                tenantPrisma,
                saleRepo: new PrismaSaleRepository(tenantPrisma),
                productsService: {
                  getProductInfoForSale: async (
                    productId: string,
                    variantId: string | null,
                  ) => ({
                    productId,
                    variantId,
                    productName: 'Croquetas',
                    variantName: null,
                    imageUrl: null,
                    unitPriceCents: 5000,
                  }),
                  checkStockAvailability: async () => ({
                    available: true,
                    currentStock: 99,
                  }),
                },
                saleCommentsRepo: { findActiveBySale: async () => [] },
                eventEmitter: { emit: jest.fn() },
                recomputePricingAndPromotions: async () => ({
                  promotionCapacityDemands: [],
                  capacityExcludedPromotionIds: [],
                }),
              });
              return sales;
            },
          },
        ],
      });
    });

    afterEach(() => world.cleanup());

    afterAll(async () => {
      await app?.close();
      await disconnectWorldPrisma();
    });

    // ─────────────────────────────── fixtures ───────────────────────────────

    interface Branch {
      tenantId: string;
      member: SeededMember;
      productId: string;
      customerId: string;
      petId: string;
      saleId: string;
      itemId: string;
    }

    const auth = (m: SeededMember) => ({ Authorization: `Bearer ${m.token}` });

    /** A customer with one ACTIVE pet and a draft with one line (pet optional). */
    async function branch(name: string, withPet: boolean): Promise<Branch> {
      const tenantId = await world.tenant(name);
      const member = await world.member(tenantId, `Cajero ${name}`, [
        'Sale:read',
        'Sale:create',
        'Sale:update',
        'Customer:read',
        'Customer:delete',
      ]);
      const productId = randomUUID();
      await prisma.product.create({
        data: { id: productId, tenantId, name: 'Croquetas', quantity: 50 },
      });
      const customerId = randomUUID();
      await prisma.customer.create({
        data: { id: customerId, tenantId, firstName: 'Rosa' },
      });
      const petId = (
        await prisma.customerPet.create({
          data: {
            tenantId,
            customerId,
            name: 'Bruno',
            nameKey: 'bruno',
            species: 'DOG',
            createdVia: 'POS',
          },
        })
      ).id;
      const saleId = (
        await request(server())
          .post('/sales/drafts')
          .set(auth(member))
          .expect(201)
      ).body.id as string;
      await request(server())
        .put(`/sales/drafts/${saleId}/customer`)
        .set(auth(member))
        .send({ customerId })
        .expect(200);
      const added = await request(server())
        .post(`/sales/drafts/${saleId}/items`)
        .set(auth(member))
        .send({ productId, quantity: 2, ...(withPet ? { petId } : {}) })
        .expect(200);
      return {
        tenantId,
        member,
        productId,
        customerId,
        petId,
        saleId,
        itemId: added.body.items[0].id as string,
      };
    }

    const setPet = (b: Branch) =>
      request(server())
        .put(`/sales/drafts/${b.saleId}/items/${b.itemId}/pet`)
        .set(auth(b.member))
        .send({ petId: b.petId });
    /** A draft save that keeps the pet line (stacks one more unit, no petId). */
    const draftSave = (b: Branch) =>
      request(server())
        .post(`/sales/drafts/${b.saleId}/items`)
        .set(auth(b.member))
        .send({ productId: b.productId, quantity: 1 });
    /** Removes the draft's only (pet) line. */
    const removeLine = (b: Branch) =>
      request(server())
        .delete(`/sales/drafts/${b.saleId}/items/${b.itemId}`)
        .set(auth(b.member));
    const clearLines = (b: Branch) =>
      request(server())
        .delete(`/sales/drafts/${b.saleId}/items`)
        .set(auth(b.member));
    const deleteCustomer = (b: Branch) =>
      request(server())
        .delete(`/customers/${b.customerId}`)
        .set(auth(b.member));

    // ───────────────────────────── handshake tools ─────────────────────────────

    /**
     * Holds `lock` in a helper transaction until `release()` is called;
     * `acquired` resolves with the helper backend's pid once the lock is held.
     */
    function holdLock(lock: (tx: typeof prisma) => Promise<unknown>) {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let held!: (pid: number) => void;
      const heldP = new Promise<number>((resolve) => (held = resolve));
      const done = prisma.$transaction(
        async (tx) => {
          const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`
            SELECT pg_backend_pid() AS pid`;
          await lock(tx as unknown as typeof prisma);
          held(pid);
          await gate;
        },
        { timeout: 30_000, maxWait: 30_000 },
      );
      return { acquired: heldP, release, done };
    }

    /**
     * Waits until ONE backend outside `chain` is blocked by a backend of
     * `chain` (`pg_blocking_pids(pid) && chain`) and returns its pid: the
     * specific new waiter, not just "some blocked backend".
     */
    async function waitBlockedBy(chain: number[]): Promise<number> {
      for (let i = 0; i < 400; i++) {
        const rows = await prisma.$queryRaw<Array<{ pid: number }>>`
          SELECT pid FROM pg_stat_activity
          WHERE pid <> ALL(${chain}::int[])
            AND pg_blocking_pids(pid) && ${chain}::int[]`;
        if (rows.length > 0) return rows[0].pid;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`no backend blocked by ${chain.join(',')} after 10 s`);
    }

    /**
     * The handshake: the helper holds a lock, `first` starts and is seen
     * blocked by the helper, `second` starts and is seen blocked by the helper
     * or by `first`, then the helper releases. Responses in start order.
     */
    async function race(
      helperLock: (tx: typeof prisma) => Promise<unknown>,
      first: () => Promise<request.Response>,
      second: () => Promise<request.Response>,
    ) {
      const helper = holdLock(helperLock);
      const helperPid = await helper.acquired;
      const a = first().then((res) => res);
      const firstPid = await waitBlockedBy([helperPid]);
      const b = second().then((res) => res);
      await waitBlockedBy([helperPid, firstPid]);
      helper.release();
      await helper.done;
      return [await a, await b] as const;
    }

    const itemRow = (b: Branch) =>
      prisma.saleItem.findFirstOrThrow({ where: { saleId: b.saleId } });
    const lockLine = (b: Branch) => (tx: typeof prisma) =>
      tx.$queryRaw`SELECT id FROM sale_items WHERE id = ${b.itemId} FOR UPDATE`;
    const lockPet = (b: Branch) => (tx: typeof prisma) =>
      tx.$queryRaw`SELECT id FROM customer_pets WHERE id = ${b.petId} FOR UPDATE`;

    /** Customer deleted, the draft detached from it, the pet and its row gone. */
    async function expectCustomerGone(b: Branch) {
      expect(await prisma.customer.count({ where: { id: b.customerId } })).toBe(
        0,
      );
      expect(await prisma.customerPet.count({ where: { id: b.petId } })).toBe(
        0,
      );
      expect(
        (await prisma.sale.findUniqueOrThrow({ where: { id: b.saleId } }))
          .customerId,
      ).toBeNull();
    }

    // ───────────────────── customer DELETE vs setItemPet ─────────────────────

    describe('PUT …/items/:itemId/pet vs DELETE /customers/:id', () => {
      it('draft first (blocked inside its write), DELETE second: both complete, the pet line keeps its snapshot', async () => {
        const b = await branch('SetPetPrimero', false);
        const [assigned, deleted] = await race(
          lockLine(b),
          () => setPet(b),
          () => deleteCustomer(b),
        );

        expect([assigned.status, deleted.status]).toEqual([200, 204]);
        await expectCustomerGone(b);
        // assigned first, then the customer (and its pets) went: §4.1 keeps the snapshot
        expect(await itemRow(b)).toMatchObject({
          petId: null,
          petNameSnapshot: 'Bruno',
          petSpeciesSnapshot: 'DOG',
        });
      }, 60_000);

      it('DELETE first (blocked on the pet), draft second: both complete and nothing dangles', async () => {
        const b = await branch('SetPetSegundo', false);
        const [deleted, assigned] = await race(
          lockPet(b),
          () => deleteCustomer(b),
          () => setPet(b),
        );

        expect(deleted.status).toBe(204);
        // the customer was gone by the time the draft looked: the pet is no longer
        // the sale's customer's (422), never a deadlock or a 500
        expect(assigned.status).toBe(422);
        expect(assigned.body).toEqual({
          statusCode: 422,
          error: 'PET_CUSTOMER_MISMATCH',
          message: 'PET_CUSTOMER_MISMATCH',
        });
        await expectCustomerGone(b);
        expect(await itemRow(b)).toMatchObject({
          petId: null,
          petNameSnapshot: null,
          petSpeciesSnapshot: null,
        });
      }, 60_000);
    });

    // ───────────────── customer DELETE vs a draft save with pets ─────────────────

    describe('draft save of a pet line (add-item without petId) vs DELETE /customers/:id', () => {
      it('draft first (blocked inside its write), DELETE second: both complete', async () => {
        const b = await branch('GuardarPrimero', true);
        const [saved, deleted] = await race(
          lockLine(b),
          () => draftSave(b),
          () => deleteCustomer(b),
        );

        expect([saved.status, deleted.status]).toEqual([200, 204]);
        await expectCustomerGone(b);
        expect(await itemRow(b)).toMatchObject({
          quantity: 3,
          petId: null,
          petNameSnapshot: 'Bruno',
          petSpeciesSnapshot: 'DOG',
        });
      }, 60_000);

      it('DELETE first (blocked on the pet), draft second: both complete; the line keeps the snapshot of the deleted customer pet', async () => {
        const b = await branch('GuardarSegundo', true);
        const [deleted, saved] = await race(
          lockPet(b),
          () => deleteCustomer(b),
          () => draftSave(b),
        );

        expect(deleted.status).toBe(204);
        expect(saved.status).toBe(200);
        expect(saved.body.items[0]).toMatchObject({
          quantity: 3,
          pet: { id: null, name: 'Bruno', species: 'DOG', status: null },
        });
        await expectCustomerGone(b);
        expect(await itemRow(b)).toMatchObject({
          quantity: 3,
          petId: null,
          petNameSnapshot: 'Bruno',
        });
      }, 60_000);
    });

    // ───── customer DELETE vs dropping the pet line (no pet left after) ─────

    describe.each([
      ['removeItem of the last pet line', 'Quitar', removeLine],
      ['clearItems', 'Vaciar', clearLines],
    ] as const)('%s vs DELETE /customers/:id', (_label, tag, drop) => {
      const lineCount = (b: Branch) =>
        prisma.saleItem.count({ where: { saleId: b.saleId } });

      it('draft first (blocked inside its write), DELETE second: both complete, the draft has no lines', async () => {
        const b = await branch(`${tag}Primero`, true);

        const [dropped, deleted] = await race(
          lockLine(b),
          () => drop(b),
          () => deleteCustomer(b),
        );

        expect([dropped.status, deleted.status]).toEqual([200, 204]);
        expect(dropped.body.items).toEqual([]);
        await expectCustomerGone(b);
        expect(await lineCount(b)).toBe(0);
      }, 60_000);

      it('DELETE first (blocked on the pet), draft second: both complete, the draft is detached and has no lines', async () => {
        const b = await branch(`${tag}Segundo`, true);

        const [deleted, dropped] = await race(
          lockPet(b),
          () => deleteCustomer(b),
          () => drop(b),
        );

        expect([deleted.status, dropped.status]).toEqual([204, 200]);
        expect(dropped.body).toMatchObject({ customerId: null, items: [] });
        await expectCustomerGone(b);
        expect(await lineCount(b)).toBe(0);
      }, 60_000);
    });
  },
);
