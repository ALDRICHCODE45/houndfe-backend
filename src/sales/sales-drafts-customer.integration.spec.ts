/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- supertest bodies are untyped JSON; test doubles are async-shaped */
/**
 * drafts-customer-summary — `GET /sales/drafts` rows carry the same
 * `customer` and `shippingAddress` summaries as the single-draft response
 * (`PUT /sales/drafts/:id/customer` → `findDraftResponseById`), against REAL
 * PostgreSQL through the real JWT → tenant → CASL chain and the real
 * `PrismaSaleRepository`.
 *
 * - draft with customer + shipping snapshot → both, same shape as PUT;
 * - draft without customer → the same nulls as the single response;
 * - the SQL statement count of one GET is independent of the number of
 *   drafts (no N+1), measured with Prisma `query` events on the client the
 *   repository uses;
 * - user and tenant isolation unchanged.
 */
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
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
import type { PrismaService } from '../shared/prisma/prisma.service';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../shared/tenant/tenant-cls-store.interface';
import { PrismaSaleRepository } from './infrastructure/prisma-sale.repository';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';

const describeIfDb = SKIP_DB_INTEGRATION ? describe.skip : describe;

describeIfDb(
  'GET /sales/drafts customer + shippingAddress (PostgreSQL)',
  () => {
    const prisma = worldPrisma();
    const world = new ZoneWorld();
    let app: INestApplication;
    const server = () => app.getHttpServer() as App;

    // The repository runs on its own client so every SQL statement it issues
    // is observable (the auth chain keeps using DatabaseModule's client).
    const countingClient = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
      log: [{ emit: 'event', level: 'query' }],
    });
    let sqlStatements = 0;
    countingClient.$on('query', () => {
      sqlStatements += 1;
    });

    beforeAll(async () => {
      app = await createZoneTestApp({
        controllers: [SalesController],
        providers: [
          {
            provide: SalesService,
            inject: [ClsService],
            useFactory: (cls: ClsService<TenantClsStore>) => {
              const tenantPrisma = new TenantPrismaService(
                countingClient as unknown as PrismaService,
                cls,
              );
              // SAFETY: the methods under test only use the ports installed below.
              const sales = Object.create(
                SalesService.prototype,
              ) as SalesService;
              Object.assign(sales, {
                tenantPrisma,
                saleRepo: new PrismaSaleRepository(tenantPrisma),
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
      await countingClient.$disconnect();
      await disconnectWorldPrisma();
    });

    // ─────────────────────────────── fixtures ───────────────────────────────

    interface Branch {
      tenantId: string;
      member: SeededMember;
      customerId: string;
      addressId: string;
    }

    const GRANTS = ['Sale:read', 'Sale:create', 'Sale:update'];

    async function branch(name: string): Promise<Branch> {
      const tenantId = await world.tenant(name);
      const member = await world.member(tenantId, `Cajero ${name}`, GRANTS);
      const customerId = randomUUID();
      await prisma.customer.create({
        data: {
          id: customerId,
          tenantId,
          firstName: 'Rosa',
          lastName: 'Pérez',
          phone: '5555555555',
          email: 'rosa@example.test',
          rfc: 'PERR800101XXX',
        },
      });
      const addressId = randomUUID();
      await prisma.customerAddress.create({
        data: {
          id: addressId,
          tenantId,
          customerId,
          street: 'Av. Reforma',
          exteriorNumber: '10',
          zipCode: '06600',
          neighborhood: 'Juárez',
          municipality: 'Cuauhtémoc',
          city: 'CDMX',
          state: 'CDMX',
          visualReferences: 'Portón negro',
          carrierPhone: '5511112222',
          label: 'Casa',
        },
      });
      return { tenantId, member, customerId, addressId };
    }

    const auth = (m: SeededMember) => ({ Authorization: `Bearer ${m.token}` });
    const http = {
      openDraft: async (m: SeededMember): Promise<string> =>
        (await request(server()).post('/sales/drafts').set(auth(m)).expect(201))
          .body.id,
      setCustomer: (m: SeededMember, saleId: string, body: object) =>
        request(server())
          .put(`/sales/drafts/${saleId}/customer`)
          .set(auth(m))
          .send(body)
          .expect(200),
      drafts: (m: SeededMember) =>
        request(server()).get('/sales/drafts').set(auth(m)).expect(200),
    };

    const rowOf = (body: any[], id: string) => body.find((r) => r.id === id);

    // ──────────────────────────────── tests ────────────────────────────────

    it('a draft with customer + shipping address lists both with the exact PUT shape', async () => {
      const b = await branch('ConCliente');
      const saleId = await http.openDraft(b.member);
      const put = await http.setCustomer(b.member, saleId, {
        customerId: b.customerId,
        shippingAddressId: b.addressId,
      });

      const list = await http.drafts(b.member);
      const row = rowOf(list.body, saleId);

      expect(row.customer).toEqual({
        id: b.customerId,
        firstName: 'Rosa',
        lastName: 'Pérez',
      });
      expect(row.shippingAddress).toEqual({
        id: b.addressId,
        street: 'Av. Reforma',
        exteriorNumber: '10',
        interiorNumber: null,
        zipCode: '06600',
        neighborhood: 'Juárez',
        municipality: 'Cuauhtémoc',
        city: 'CDMX',
        state: 'CDMX',
      });
      expect(row.customer).toEqual(put.body.customer);
      expect(row.shippingAddress).toEqual(put.body.shippingAddress);
      // Existing keys still present and consistent.
      expect(row.customerId).toBe(b.customerId);
      expect(row.shippingAddressId).toBe(b.addressId);
      // Nothing beyond the summary leaks from the customer row.
      expect(Object.keys(row.customer).sort()).toEqual(
        ['firstName', 'id', 'lastName'].sort(),
      );
    });

    it('a draft with a customer but no address → customer + null shippingAddress, as PUT', async () => {
      const b = await branch('SinDireccion');
      const saleId = await http.openDraft(b.member);
      const put = await http.setCustomer(b.member, saleId, {
        customerId: b.customerId,
      });

      const row = rowOf((await http.drafts(b.member)).body, saleId);

      expect(row.customer).toEqual(put.body.customer);
      expect(row.shippingAddress).toBeNull();
      expect(put.body.shippingAddress).toBeNull();
    });

    it('a draft without customer lists customer: null and shippingAddress: null', async () => {
      const b = await branch('SinCliente');
      const saleId = await http.openDraft(b.member);

      const row = rowOf((await http.drafts(b.member)).body, saleId);

      expect(row).toHaveProperty('customer', null);
      expect(row).toHaveProperty('shippingAddress', null);
      expect(row.customerId).toBeNull();
      expect(row.shippingAddressId).toBeNull();
    });

    it('issues the same number of SQL statements for 1 draft and for 6 drafts with customers (no N+1)', async () => {
      const b = await branch('SinNmas1');
      const first = await http.openDraft(b.member);
      await http.setCustomer(b.member, first, {
        customerId: b.customerId,
        shippingAddressId: b.addressId,
      });

      sqlStatements = 0;
      const one = await http.drafts(b.member);
      const statementsForOne = sqlStatements;
      expect(one.body).toHaveLength(1);

      for (let i = 0; i < 5; i += 1) {
        const id = await http.openDraft(b.member);
        if (i % 2 === 0) {
          await http.setCustomer(b.member, id, {
            customerId: b.customerId,
            shippingAddressId: b.addressId,
          });
        }
      }

      sqlStatements = 0;
      const six = await http.drafts(b.member);
      const statementsForSix = sqlStatements;

      expect(six.body).toHaveLength(6);
      expect(six.body.filter((r: any) => r.customer !== null)).toHaveLength(4);
      expect(statementsForOne).toBeGreaterThan(0);
      expect(statementsForSix).toBe(statementsForOne);
      // Report the bounded count in the test output for the handoff.
      console.log(
        `[drafts-customer-summary] SQL statements per GET /sales/drafts: 1 draft=${statementsForOne}, 6 drafts=${statementsForSix}`,
      );
    });

    it('keeps user and tenant isolation and the newest-first order', async () => {
      const a = await branch('Norte');
      const colleague = await world.member(a.tenantId, 'Cajero 2', GRANTS);
      const other = await branch('Sur');

      const older = await http.openDraft(a.member);
      await http.setCustomer(a.member, older, {
        customerId: a.customerId,
        shippingAddressId: a.addressId,
      });
      const newer = await http.openDraft(a.member);
      const colleagueDraft = await http.openDraft(colleague);
      await http.setCustomer(colleague, colleagueDraft, {
        customerId: a.customerId,
      });
      const foreignDraft = await http.openDraft(other.member);
      await http.setCustomer(other.member, foreignDraft, {
        customerId: other.customerId,
        shippingAddressId: other.addressId,
      });

      const mine = (await http.drafts(a.member)).body;
      expect(mine.map((r: any) => r.id)).toEqual([newer, older]);
      expect(mine.every((r: any) => r.userId === a.member.userId)).toBe(true);
      expect(rowOf(mine, older).customer.id).toBe(a.customerId);
      expect(rowOf(mine, newer).customer).toBeNull();

      const theirs = (await http.drafts(colleague)).body;
      expect(theirs.map((r: any) => r.id)).toEqual([colleagueDraft]);

      const foreign = (await http.drafts(other.member)).body;
      expect(foreign.map((r: any) => r.id)).toEqual([foreignDraft]);
      expect(foreign[0].customer.id).toBe(other.customerId);
      expect(foreign[0].shippingAddress.id).toBe(other.addressId);
    });
  },
);
