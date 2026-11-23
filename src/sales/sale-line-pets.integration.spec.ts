/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await -- supertest bodies are untyped JSON; test doubles are async-shaped */
/**
 * customer-pets / T3 (S7, S8 POS history) — the pet on a POS sale line against
 * REAL PostgreSQL through the real JWT → tenant → CASL chain, the production
 * validation pipe and the real `PrismaSaleRepository`.
 *
 * Every test asserts status, exact error body, response members and the
 * database (unchanged on every rejection).
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
import { CustomerPetsService } from '../customer-pets/application/customer-pets.service';
import { CUSTOMER_PET_REPOSITORY } from '../customer-pets/domain/customer-pet.repository';
import { PrismaCustomerPetRepository } from '../customer-pets/infrastructure/prisma-customer-pet.repository';
import { CustomerPetsController } from '../customer-pets/presentation/customer-pets.controller';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import { PrismaSaleRepository } from './infrastructure/prisma-sale.repository';
import { SalesController } from './sales.controller';
import { SalesQueryController } from './sales-query.controller';
import { SalesService } from './sales.service';

const describeIfDb = SKIP_DB_INTEGRATION ? describe.skip : describe;

describeIfDb('POS sale line pets (PostgreSQL)', () => {
  const prisma = worldPrisma();
  const world = new ZoneWorld();
  let app: INestApplication;
  const server = () => app.getHttpServer() as App;

  beforeAll(async () => {
    app = await createZoneTestApp({
      controllers: [
        SalesController,
        SalesQueryController,
        CustomerPetsController,
      ],
      providers: [
        CustomerPetsService,
        {
          provide: CUSTOMER_PET_REPOSITORY,
          useClass: PrismaCustomerPetRepository,
        },
        {
          provide: SalesService,
          inject: [TenantPrismaService],
          useFactory: (tenantPrisma: TenantPrismaService) => {
            // SAFETY: the methods under test only use the ports installed below.
            const sales = Object.create(SalesService.prototype) as SalesService;
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
    c1: string;
    c2: string;
    bruno: string; // ACTIVE, c1
    max: string; // ACTIVE, c1
    rex: string; // ARCHIVED, c1
    luna: string; // ACTIVE, c2
  }

  const nameKey = (n: string) => n.toLowerCase();

  async function branch(name: string): Promise<Branch> {
    const tenantId = await world.tenant(name);
    const member = await world.member(tenantId, `Cajero ${name}`, [
      'Sale:read',
      'Sale:create',
      'Sale:update',
      'Customer:read',
      'Customer:update',
      'Customer:delete',
    ]);
    const productId = randomUUID();
    await prisma.product.create({
      data: { id: productId, tenantId, name: 'Croquetas', quantity: 50 },
    });
    const c1 = randomUUID();
    const c2 = randomUUID();
    await prisma.customer.create({
      data: { id: c1, tenantId, firstName: 'Rosa' },
    });
    await prisma.customer.create({
      data: { id: c2, tenantId, firstName: 'Luis' },
    });
    const pet = async (
      customerId: string,
      petName: string,
      species: 'DOG' | 'CAT' = 'DOG',
      status: 'ACTIVE' | 'ARCHIVED' = 'ACTIVE',
    ) =>
      (
        await prisma.customerPet.create({
          data: {
            tenantId,
            customerId,
            name: petName,
            nameKey: nameKey(petName),
            species,
            status,
            createdVia: 'POS',
          },
        })
      ).id;
    return {
      tenantId,
      member,
      productId,
      c1,
      c2,
      bruno: await pet(c1, 'Bruno'),
      max: await pet(c1, 'Max', 'CAT'),
      rex: await pet(c1, 'Rex', 'DOG', 'ARCHIVED'),
      luna: await pet(c2, 'Luna', 'CAT'),
    };
  }

  const auth = (m: SeededMember) => ({ Authorization: `Bearer ${m.token}` });
  const http = {
    openDraft: (b: Branch) =>
      request(server()).post('/sales/drafts').set(auth(b.member)),
    addItem: (b: Branch, saleId: string, body: object) =>
      request(server())
        .post(`/sales/drafts/${saleId}/items`)
        .set(auth(b.member))
        .send(body),
    setPet: (b: Branch, saleId: string, itemId: string, body: object) =>
      request(server())
        .put(`/sales/drafts/${saleId}/items/${itemId}/pet`)
        .set(auth(b.member))
        .send(body),
    setCustomer: (b: Branch, saleId: string, customerId: string) =>
      request(server())
        .put(`/sales/drafts/${saleId}/customer`)
        .set(auth(b.member))
        .send({ customerId }),
    clearCustomer: (b: Branch, saleId: string) =>
      request(server())
        .delete(`/sales/drafts/${saleId}/customer`)
        .set(auth(b.member)),
    drafts: (b: Branch) =>
      request(server()).get('/sales/drafts').set(auth(b.member)),
    detail: (b: Branch, saleId: string) =>
      request(server()).get(`/sales/${saleId}`).set(auth(b.member)),
    history: (b: Branch, query: string) =>
      request(server()).get(`/sales?${query}`).set(auth(b.member)),
  };

  const errorBody = (statusCode: number, code: string) => ({
    statusCode,
    error: code,
    message: code,
  });

  /** A draft of `customerId` (or none) with one line; returns ids. */
  async function draftWithLine(
    b: Branch,
    customerId: string | null,
    petId?: string | null,
  ) {
    const saleId = (await http.openDraft(b).expect(201)).body.id as string;
    if (customerId) await http.setCustomer(b, saleId, customerId).expect(200);
    const res = await http
      .addItem(b, saleId, {
        productId: b.productId,
        quantity: 2,
        ...(petId !== undefined ? { petId } : {}),
      })
      .expect(200);
    return { saleId, itemId: res.body.items[0].id as string, body: res.body };
  }

  const lineRow = (saleId: string) =>
    prisma.saleItem.findFirstOrThrow({ where: { saleId } });
  const petColumns = async (saleId: string) => {
    const { petId, petNameSnapshot, petSpeciesSnapshot } =
      await lineRow(saleId);
    return { petId, petNameSnapshot, petSpeciesSnapshot };
  };
  const NO_PET = {
    petId: null,
    petNameSnapshot: null,
    petSpeciesSnapshot: null,
  };

  let folioSeq = 0;
  /** A CONFIRMED sale written straight to the database, one line per pet entry. */
  async function confirmedSale(
    b: Branch,
    customerId: string | null,
    lines: Array<{
      petId?: string | null;
      name?: string | null;
      species?: 'DOG' | 'CAT' | null;
    }>,
  ) {
    const id = randomUUID();
    await prisma.sale.create({
      data: {
        id,
        tenantId: b.tenantId,
        userId: b.member.userId,
        customerId,
        status: 'CONFIRMED',
        channel: 'POS',
        folio: `PET-${++folioSeq}-${id.slice(0, 6)}`,
        confirmedAt: new Date(Date.UTC(2026, 10, 1, 10, folioSeq)),
        subtotalCents: 5000 * lines.length,
        totalCents: 5000 * lines.length,
        paidCents: 5000 * lines.length,
        paymentStatus: 'PAID',
        items: {
          create: lines.map((l) => ({
            tenantId: b.tenantId,
            productId: b.productId,
            productName: 'Croquetas',
            quantity: 1,
            unitPriceCents: 5000,
            petId: l.petId ?? null,
            petNameSnapshot: l.name ?? null,
            petSpeciesSnapshot: l.species ?? null,
          })),
        },
      },
    });
    return id;
  }

  // ─────────────────── S7: draft line pet (create / update) ───────────────────

  describe('draft line pet', () => {
    it('add-item without petId: `pet: null` on the line and the columns stay empty (regression)', async () => {
      const b = await branch('SinPet');
      const { saleId, body } = await draftWithLine(b, b.c1);

      expect(body.items[0].pet).toBeNull();
      expect(body.items[0]).toMatchObject({
        productId: b.productId,
        quantity: 2,
        unitPriceCents: 5000,
      });
      expect(await petColumns(saleId)).toEqual(NO_PET);
    });

    it('PUT /sales/drafts/:id/items/:itemId/pet assigns an ACTIVE pet of the customer and copies the snapshot', async () => {
      const b = await branch('Asignar');
      const { saleId, itemId } = await draftWithLine(b, b.c1);

      const res = await http
        .setPet(b, saleId, itemId, { petId: b.bruno })
        .expect(200);

      expect(res.body.items[0].pet).toEqual({
        id: b.bruno,
        name: 'Bruno',
        species: 'DOG',
        status: 'ACTIVE',
      });
      expect(await petColumns(saleId)).toEqual({
        petId: b.bruno,
        petNameSnapshot: 'Bruno',
        petSpeciesSnapshot: 'DOG',
      });
      // the draft list the POS reloads carries it too
      const drafts = await http.drafts(b).expect(200);
      expect(drafts.body[0].items[0].pet).toEqual(res.body.items[0].pet);
    });

    it('add-item with petId assigns it on the new line', async () => {
      const b = await branch('AddConPet');
      const { saleId, body } = await draftWithLine(b, b.c1, b.max);

      expect(body.items[0].pet).toEqual({
        id: b.max,
        name: 'Max',
        species: 'CAT',
        status: 'ACTIVE',
      });
      expect(await petColumns(saleId)).toEqual({
        petId: b.max,
        petNameSnapshot: 'Max',
        petSpeciesSnapshot: 'CAT',
      });
    });

    it('add-item with the same product and a petId stacks the quantity and sets that pet on the line', async () => {
      const b = await branch('Apilar');
      const { saleId } = await draftWithLine(b, b.c1);

      const res = await http
        .addItem(b, saleId, {
          productId: b.productId,
          quantity: 1,
          petId: b.bruno,
        })
        .expect(200);

      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0]).toMatchObject({ quantity: 3 });
      expect(res.body.items[0].pet).toMatchObject({ id: b.bruno });
      expect(await prisma.saleItem.count({ where: { saleId } })).toBe(1);
    });

    it('petId null clears pet and snapshot', async () => {
      const b = await branch('Limpiar');
      const { saleId, itemId } = await draftWithLine(b, b.c1, b.bruno);

      const res = await http
        .setPet(b, saleId, itemId, { petId: null })
        .expect(200);

      expect(res.body.items[0].pet).toBeNull();
      expect(await petColumns(saleId)).toEqual(NO_PET);
    });

    it('unknown pet → 404 PET_NOT_FOUND; DB unchanged', async () => {
      const b = await branch('Desconocida');
      const { saleId, itemId } = await draftWithLine(b, b.c1);

      const res = await http
        .setPet(b, saleId, itemId, { petId: randomUUID() })
        .expect(404);

      expect(res.body).toEqual(errorBody(404, 'PET_NOT_FOUND'));
      expect(await petColumns(saleId)).toEqual(NO_PET);
    });

    it('pet of another tenant → 404 PET_NOT_FOUND', async () => {
      const b = await branch('Propia');
      const other = await branch('Ajena');
      const { saleId, itemId } = await draftWithLine(b, b.c1);

      const res = await http
        .setPet(b, saleId, itemId, { petId: other.bruno })
        .expect(404);

      expect(res.body).toEqual(errorBody(404, 'PET_NOT_FOUND'));
      expect(await petColumns(saleId)).toEqual(NO_PET);
    });

    it('pet of ANOTHER customer → 422 PET_CUSTOMER_MISMATCH; DB unchanged', async () => {
      const b = await branch('Ajeno');
      const { saleId, itemId } = await draftWithLine(b, b.c1);

      const res = await http
        .setPet(b, saleId, itemId, { petId: b.luna })
        .expect(422);

      expect(res.body).toEqual(errorBody(422, 'PET_CUSTOMER_MISMATCH'));
      expect(await petColumns(saleId)).toEqual(NO_PET);
    });

    it('sale WITHOUT customer: any petId → 422 PET_CUSTOMER_MISMATCH', async () => {
      const b = await branch('SinCliente');
      const { saleId, itemId } = await draftWithLine(b, null);

      const res = await http
        .setPet(b, saleId, itemId, { petId: b.bruno })
        .expect(422);

      expect(res.body).toEqual(errorBody(422, 'PET_CUSTOMER_MISMATCH'));
      expect(await petColumns(saleId)).toEqual(NO_PET);
    });

    it('ARCHIVED pet → 422 PET_ARCHIVED; DB unchanged', async () => {
      const b = await branch('Archivada');
      const { saleId, itemId } = await draftWithLine(b, b.c1);

      const res = await http
        .setPet(b, saleId, itemId, { petId: b.rex })
        .expect(422);

      expect(res.body).toEqual(errorBody(422, 'PET_ARCHIVED'));
      expect(await petColumns(saleId)).toEqual(NO_PET);
    });

    it('add-item with a refused petId rejects the whole add (no line created)', async () => {
      const b = await branch('AddRechazado');
      const saleId = (await http.openDraft(b).expect(201)).body.id as string;
      await http.setCustomer(b, saleId, b.c1).expect(200);

      const res = await http
        .addItem(b, saleId, {
          productId: b.productId,
          quantity: 1,
          petId: b.luna,
        })
        .expect(422);

      expect(res.body).toEqual(errorBody(422, 'PET_CUSTOMER_MISMATCH'));
      expect(await prisma.saleItem.count({ where: { saleId } })).toBe(0);
    });

    it('invalid petId (not a uuid / a number) → 400 and nothing changes', async () => {
      const b = await branch('Invalido');
      const { saleId, itemId } = await draftWithLine(b, b.c1);

      await http.setPet(b, saleId, itemId, { petId: 'nope' }).expect(400);
      await http.setPet(b, saleId, itemId, {}).expect(400);
      expect(await petColumns(saleId)).toEqual(NO_PET);
    });

    it('an UPPER-CASED petId of an existing pet is accepted (set-pet and add-item) and stores the real id', async () => {
      const b = await branch('Mayusculas');
      const { saleId, itemId } = await draftWithLine(b, b.c1);

      const res = await http
        .setPet(b, saleId, itemId, { petId: b.bruno.toUpperCase() })
        .expect(200);
      expect(res.body.items[0].pet).toEqual({
        id: b.bruno,
        name: 'Bruno',
        species: 'DOG',
        status: 'ACTIVE',
      });
      expect((await petColumns(saleId)).petId).toBe(b.bruno);

      const other = await draftWithLine(b, b.c1, b.max.toUpperCase());
      expect(other.body.items[0].pet).toMatchObject({ id: b.max, name: 'Max' });
      expect((await petColumns(other.saleId)).petId).toBe(b.max);
    });

    it('archiving the pet later does not touch the line; its status follows, the snapshot does not', async () => {
      const b = await branch('Snapshot');
      const { saleId } = await draftWithLine(b, b.c1, b.bruno);

      await prisma.customerPet.update({
        where: { id: b.bruno },
        data: {
          name: 'Bruno II',
          status: 'ARCHIVED',
          version: { increment: 1 },
        },
      });

      const drafts = await http.drafts(b).expect(200);
      expect(drafts.body[0].items[0].pet).toEqual({
        id: b.bruno,
        name: 'Bruno',
        species: 'DOG',
        status: 'ARCHIVED',
      });
      expect(await petColumns(saleId)).toEqual({
        petId: b.bruno,
        petNameSnapshot: 'Bruno',
        petSpeciesSnapshot: 'DOG',
      });
      // saving another change of the draft keeps the line's pet
      const again = await http
        .addItem(b, saleId, { productId: b.productId, quantity: 1 })
        .expect(200);
      expect(again.body.items[0].pet).toMatchObject({
        name: 'Bruno',
        status: 'ARCHIVED',
      });
    });
  });

  // ──────────────── S7: customer change clears the line pets ────────────────

  describe('customer change on a draft', () => {
    it('a different customer clears every line pet and answers petsCleared: true', async () => {
      const b = await branch('CambioCliente');
      const { saleId } = await draftWithLine(b, b.c1, b.bruno);

      const res = await http.setCustomer(b, saleId, b.c2).expect(200);

      expect(res.body.petsCleared).toBe(true);
      expect(res.body.customerId).toBe(b.c2);
      expect(res.body.items[0].pet).toBeNull();
      expect(await petColumns(saleId)).toEqual(NO_PET);
    });

    it('the SAME customer again keeps the pets and answers petsCleared: false', async () => {
      const b = await branch('MismoCliente');
      const { saleId } = await draftWithLine(b, b.c1, b.bruno);

      const res = await http.setCustomer(b, saleId, b.c1).expect(200);

      expect(res.body.petsCleared).toBe(false);
      expect(res.body.items[0].pet).toMatchObject({ id: b.bruno });
      expect((await petColumns(saleId)).petId).toBe(b.bruno);
    });

    it('a change with no pets on the lines answers petsCleared: false (regression of the response)', async () => {
      const b = await branch('SinPetsCambio');
      const { saleId } = await draftWithLine(b, b.c1);

      const res = await http.setCustomer(b, saleId, b.c2).expect(200);

      expect(res.body.petsCleared).toBe(false);
      expect(res.body.customerId).toBe(b.c2);
      expect(res.body.items).toHaveLength(1);
    });

    it('removing the customer (DELETE, still 204) clears the line pets', async () => {
      const b = await branch('QuitarCliente');
      const { saleId } = await draftWithLine(b, b.c1, b.bruno);

      const res = await http.clearCustomer(b, saleId).expect(204);

      expect(res.body).toEqual({});
      expect(await petColumns(saleId)).toEqual(NO_PET);
      expect(
        (await prisma.sale.findUniqueOrThrow({ where: { id: saleId } }))
          .customerId,
      ).toBeNull();
    });
  });

  // ───────────────── S7: `pet` in the confirmed-sale detail ─────────────────

  describe('GET /sales/:id', () => {
    it('exposes pet per line: snapshot + CURRENT status; null without snapshot', async () => {
      const b = await branch('Detalle');
      const id = await confirmedSale(b, b.c1, [
        { petId: b.bruno, name: 'Bruno', species: 'DOG' },
        { petId: b.rex, name: 'Rex', species: 'DOG' }, // archived afterwards
        {}, // no pet / old line
        { petId: null, name: null, species: null }, // erased pet
      ]);

      const res = await http.detail(b, id).expect(200);

      const pets = (res.body.items as Array<{ pet: unknown }>).map(
        (i) => i.pet,
      );
      expect(pets).toEqual(
        expect.arrayContaining([
          { id: b.bruno, name: 'Bruno', species: 'DOG', status: 'ACTIVE' },
          { id: b.rex, name: 'Rex', species: 'DOG', status: 'ARCHIVED' },
        ]),
      );
      expect(pets.filter((p) => p === null)).toHaveLength(2);
      expect(res.body.items).toHaveLength(4);
    });

    it('customer deleted: the snapshot stays with status null (and id null)', async () => {
      const b = await branch('ClienteBorrado');
      const id = await confirmedSale(b, b.c1, [
        { petId: b.bruno, name: 'Bruno', species: 'DOG' },
      ]);

      await prisma.customer.delete({ where: { id: b.c1 } });

      const res = await http.detail(b, id).expect(200);
      expect(res.body.items[0].pet).toEqual({
        id: null,
        name: 'Bruno',
        species: 'DOG',
        status: null,
      });
    });

    it('a pet erased through the POS DELETE route reads pet: null and keeps line, product and amount', async () => {
      const b = await branch('Borrada');
      const id = await confirmedSale(b, b.c1, [
        { petId: b.bruno, name: 'Bruno', species: 'DOG' },
      ]);

      await request(server())
        .delete(`/customers/${b.c1}/pets/${b.bruno}?version=1`)
        .set(auth(b.member))
        .expect(204);

      const res = await http.detail(b, id).expect(200);
      expect(res.body.items[0].pet).toBeNull();
      expect(res.body.items[0]).toMatchObject({
        productName: 'Croquetas',
        unitPriceCents: 5000,
        quantity: 1,
      });
      expect(res.body.totalCents).toBe(5000);
    });
  });

  // ─────────────── S8: POS customer sales history `?petId=` ───────────────

  describe('GET /sales?customerId=&petId= (POS customer card history)', () => {
    async function history(b: Branch) {
      const withBruno = await confirmedSale(b, b.c1, [
        { petId: b.bruno, name: 'Bruno', species: 'DOG' },
        { petId: b.max, name: 'Max', species: 'CAT' },
      ]);
      const onlyMax = await confirmedSale(b, b.c1, [
        { petId: b.max, name: 'Max', species: 'CAT' },
      ]);
      const noPet = await confirmedSale(b, b.c1, [{}]);
      const brunoAgain = await confirmedSale(b, b.c1, [
        { petId: b.bruno, name: 'Bruno', species: 'DOG' },
      ]);
      const other = await confirmedSale(b, b.c2, [
        { petId: b.luna, name: 'Luna', species: 'CAT' },
      ]);
      return { withBruno, onlyMax, noPet, brunoAgain, other };
    }
    const ids = (res: request.Response) =>
      (res.body.data as Array<{ id: string }>).map((s) => s.id).sort();

    it('lists only the customer sales with at least one line for that pet; pagination and filterSummary follow', async () => {
      const b = await branch('Historial');
      const s = await history(b);

      const res = await http
        .history(b, `customerId=${b.c1}&petId=${b.bruno}`)
        .expect(200);

      expect(ids(res)).toEqual([s.withBruno, s.brunoAgain].sort());
      expect(res.body.pagination.total).toBe(2);
      expect(res.body.filterSummary.count).toBe(2);
      expect(res.body.filterSummary.totalCents).toBe(10000 + 5000);
    });

    it('a sale with two lines for the pet is listed once', async () => {
      const b = await branch('Doble');
      const id = await confirmedSale(b, b.c1, [
        { petId: b.bruno, name: 'Bruno', species: 'DOG' },
        { petId: b.bruno, name: 'Bruno', species: 'DOG' },
      ]);

      const res = await http
        .history(b, `customerId=${b.c1}&petId=${b.bruno}`)
        .expect(200);

      expect(ids(res)).toEqual([id]);
      expect(res.body.pagination.total).toBe(1);
    });

    it('a pet with no sales → 200 with an empty list (only a foreign/unknown pet is 404)', async () => {
      const b = await branch('SinVentas');
      await history(b);

      const res = await http
        .history(b, `customerId=${b.c1}&petId=${b.rex}`)
        .expect(200);

      expect(res.body.data).toEqual([]);
      expect(res.body.pagination.total).toBe(0);
    });

    it('petId of another customer → 404 PET_NOT_FOUND, never an empty list', async () => {
      const b = await branch('PetAjena');
      await history(b);

      const res = await http
        .history(b, `customerId=${b.c1}&petId=${b.luna}`)
        .expect(404);

      expect(res.body).toEqual(errorBody(404, 'PET_NOT_FOUND'));
    });

    it('unknown petId and a pet of another tenant → 404 PET_NOT_FOUND', async () => {
      const b = await branch('PetDesconocida');
      const other = await branch('PetOtroTenant');

      for (const petId of [randomUUID(), other.bruno]) {
        const res = await http
          .history(b, `customerId=${b.c1}&petId=${petId}`)
          .expect(404);
        expect(res.body).toEqual(errorBody(404, 'PET_NOT_FOUND'));
      }
    });

    it('petId needs exactly one customerId; a non-uuid petId is a 400', async () => {
      const b = await branch('Invalidos');
      await history(b);

      const noCustomer = await http.history(b, `petId=${b.bruno}`).expect(400);
      expect(noCustomer.body).toEqual(
        errorBody(400, 'PET_FILTER_REQUIRES_CUSTOMER'),
      );
      const twoCustomers = await http
        .history(b, `customerId=${b.c1},${b.c2}&petId=${b.bruno}`)
        .expect(400);
      expect(twoCustomers.body).toEqual(
        errorBody(400, 'PET_FILTER_REQUIRES_CUSTOMER'),
      );
      await http.history(b, `customerId=${b.c1}&petId=nope`).expect(400);
    });

    it('an UPPER-CASED petId is accepted by the history filter', async () => {
      const b = await branch('HistMayus');
      const s = await history(b);

      const res = await http
        .history(b, `customerId=${b.c1}&petId=${b.bruno.toUpperCase()}`)
        .expect(200);

      expect(ids(res)).toEqual([s.withBruno, s.brunoAgain].sort());
    });

    it('without petId the customer history is unchanged (regression)', async () => {
      const b = await branch('SinFiltro');
      const s = await history(b);

      const res = await http.history(b, `customerId=${b.c1}`).expect(200);

      expect(ids(res)).toEqual(
        [s.withBruno, s.onlyMax, s.noPet, s.brunoAgain].sort(),
      );
      expect(res.body.pagination.total).toBe(4);
      expect(res.body.summary.salesCount).toBe(4);
    });

    it('the KPI summary stays the customer one while the list is narrowed by the pet', async () => {
      const b = await branch('KPI');
      await history(b);

      const res = await http
        .history(b, `customerId=${b.c1}&petId=${b.max}`)
        .expect(200);

      expect(res.body.pagination.total).toBe(2);
      expect(res.body.summary.salesCount).toBe(4);
    });
  });

  // ─────────────────── locking: pet FOR SHARE vs pet erase ───────────────────

  describe('pet row lock on assignment', () => {
    it('assigning waits for a pet erase in flight (FOR UPDATE) and then answers 404 PET_NOT_FOUND, never a 500', async () => {
      const b = await branch('Carrera');
      const { saleId, itemId } = await draftWithLine(b, b.c1);

      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const lockedP = new Promise<void>((resolve) => (locked = resolve));
      // The eraser of contract §6: lock the pet FOR UPDATE, scrub, delete — and
      // hold the transaction open until the assignment is in flight.
      const eraser = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM customer_pets WHERE id = ${b.bruno} FOR UPDATE`;
        locked();
        await gate;
        await tx.saleItem.updateMany({
          where: { petId: b.bruno },
          data: {
            petId: null,
            petNameSnapshot: null,
            petSpeciesSnapshot: null,
          },
        });
        await tx.customerPet.delete({ where: { id: b.bruno } });
      });
      await lockedP;

      let settled = false;
      const assignment = http
        .setPet(b, saleId, itemId, { petId: b.bruno })
        .then((res) => {
          settled = true;
          return res;
        });
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(settled).toBe(false); // blocked on the pet lock, not a stale read

      release();
      await eraser;
      const res = await assignment;

      expect(res.status).toBe(404);
      expect(res.body).toEqual(errorBody(404, 'PET_NOT_FOUND'));
      expect(await petColumns(saleId)).toEqual(NO_PET);
    }, 20_000);

    it('a pet erase issued while the line is being written scrubs it (no snapshot of an erased pet survives)', async () => {
      const b = await branch('Carrera2');
      const { saleId, itemId } = await draftWithLine(b, b.c1);

      // A share lock on the pet (what the assignment holds until its commit)
      // makes the eraser wait; the line is written under that lock.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const lockedP = new Promise<void>((resolve) => (locked = resolve));
      const holder = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM customer_pets WHERE id = ${b.bruno} FOR SHARE`;
        locked();
        await gate;
        await tx.saleItem.update({
          where: { id: itemId },
          data: {
            petId: b.bruno,
            petNameSnapshot: 'Bruno',
            petSpeciesSnapshot: 'DOG',
          },
        });
      });
      await lockedP;

      let erased = false;
      const erase = request(server())
        .delete(`/customers/${b.c1}/pets/${b.bruno}?version=1`)
        .set(auth(b.member))
        .then((res) => {
          erased = true;
          return res;
        });
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(erased).toBe(false);

      release();
      await holder;
      const res = await erase;

      expect(res.status).toBe(204);
      expect(await petColumns(saleId)).toEqual(NO_PET);
      expect(await prisma.customerPet.count({ where: { id: b.bruno } })).toBe(
        0,
      );
    }, 20_000);
  });
});
