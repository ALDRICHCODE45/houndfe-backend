/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- supertest bodies are untyped JSON */
/**
 * customer-pets / T1 (S4) — the pet-aware additions to `GET /customers/:id`
 * (`activePetsCount`) and `GET /customers?search=` (ACTIVE pet names,
 * `matchedPetName`) against REAL PostgreSQL, plus proof that the existing
 * customer reads and writes keep their behaviour.
 */
import type { INestApplication } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
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
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { CUSTOMER_REPOSITORY } from './domain/customer.repository';
import { PrismaCustomerRepository } from './infrastructure/prisma-customer.repository';

const describeIfDb = SKIP_DB_INTEGRATION ? describe.skip : describe;

describeIfDb('customers with pets (PostgreSQL)', () => {
  const prisma = worldPrisma();
  const world = new ZoneWorld();
  let app: INestApplication;
  const server = () => app.getHttpServer() as App;

  interface Branch {
    tenantId: string;
    member: SeededMember;
  }

  beforeAll(async () => {
    app = await createZoneTestApp({
      controllers: [CustomersController],
      providers: [
        CustomersService,
        { provide: CUSTOMER_REPOSITORY, useClass: PrismaCustomerRepository },
      ],
    });
  });

  afterEach(() => world.cleanup());

  afterAll(async () => {
    await app?.close();
    await disconnectWorldPrisma();
  });

  async function branch(name: string): Promise<Branch> {
    const tenantId = await world.tenant(name);
    const member = await world.member(tenantId, `Gerente ${name}`, [
      'Customer:read',
      'Customer:create',
      'Customer:update',
    ]);
    return { tenantId, member };
  }

  async function customer(
    b: Branch,
    firstName: string,
    over: Partial<Prisma.CustomerUncheckedCreateInput> = {},
  ): Promise<string> {
    const id = randomUUID();
    await prisma.customer.create({
      data: { id, tenantId: b.tenantId, firstName, ...over },
    });
    return id;
  }

  async function pet(
    b: Branch,
    customerId: string,
    name: string,
    over: Partial<Prisma.CustomerPetUncheckedCreateInput> = {},
  ) {
    return prisma.customerPet.create({
      data: {
        tenantId: b.tenantId,
        customerId,
        name,
        nameKey: name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase(),
        species: 'DOG',
        createdVia: 'POS',
        ...over,
      },
    });
  }

  const auth = (m: SeededMember) => ({ Authorization: `Bearer ${m.token}` });
  const getOne = (m: SeededMember, id: string) =>
    request(server()).get(`/customers/${id}`).set(auth(m));
  const search = (m: SeededMember, q?: string) =>
    request(server())
      .get('/customers')
      .query(q === undefined ? {} : { search: q })
      .set(auth(m));

  interface ListItem {
    id: string;
    firstName: string;
    matchedPetName: string | null;
  }
  const summary = (items: ListItem[]) =>
    items.map((i) => [i.firstName, i.matchedPetName]);

  describe('GET /customers/:id', () => {
    it('activePetsCount counts only ACTIVE pets of that customer, and every existing field is still there', async () => {
      const b = await branch('Detalle');
      const c = await customer(b, 'Rosa', {
        lastName: 'Pérez',
        email: 'rosa@x.test',
      });
      const other = await customer(b, 'Pedro');
      await pet(b, c, 'Bruno');
      await pet(b, c, 'Max');
      await pet(b, c, 'Viejo', { status: 'ARCHIVED', archivedAt: new Date() });
      await pet(b, other, 'Ajeno');

      const res = await getOne(b.member, c).expect(200);

      expect(res.body).toMatchObject({
        id: c,
        firstName: 'Rosa',
        lastName: 'Pérez',
        email: 'rosa@x.test',
        globalPriceList: null,
        addresses: [],
        activePetsCount: 2,
      });
      expect(res.body).not.toHaveProperty('_count');
      expect(res.body).not.toHaveProperty('pets');
      expect(Object.keys(res.body)).toEqual(
        expect.arrayContaining([
          'createdAt',
          'updatedAt',
          'rfc',
          'billingState',
        ]),
      );
    });

    it('a customer without pets reads activePetsCount 0', async () => {
      const b = await branch('DetalleCero');
      const c = await customer(b, 'Rosa');
      const res = await getOne(b.member, c).expect(200);
      expect(res.body.activePetsCount).toBe(0);
    });

    it("unknown id and another branch's customer stay 404 ENTITY_NOT_FOUND", async () => {
      const b = await branch('Detalle404');
      const other = await branch('Detalle404 B');
      const foreign = await customer(other, 'Ajena');
      await pet(other, foreign, 'Bruno');
      for (const id of [randomUUID(), foreign]) {
        const res = await getOne(b.member, id).expect(404);
        expect(res.body.error).toBe('ENTITY_NOT_FOUND');
      }
    });

    it('create and update responses keep their shape (no activePetsCount)', async () => {
      const b = await branch('Escrituras');
      const created = await request(server())
        .post('/customers')
        .set(auth(b.member))
        .send({ firstName: 'Nueva' })
        .expect(201);
      expect(created.body.firstName).toBe('Nueva');
      expect(created.body).not.toHaveProperty('activePetsCount');
      const updated = await request(server())
        .patch(`/customers/${created.body.id}`)
        .set(auth(b.member))
        .send({ lastName: 'Cliente' })
        .expect(200);
      expect(updated.body.lastName).toBe('Cliente');
      expect(updated.body).not.toHaveProperty('activePetsCount');
    });
  });

  describe('GET /customers (no search)', () => {
    it('lists every customer of the branch newest first, each with matchedPetName null, other fields unchanged', async () => {
      const b = await branch('Lista');
      const other = await branch('Lista B');
      const older = await customer(b, 'Antigua', {
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      await customer(b, 'Reciente', {
        createdAt: new Date('2026-02-01T00:00:00.000Z'),
      });
      await pet(b, older, 'Bruno');
      const foreign = await customer(other, 'Ajena');
      await pet(other, foreign, 'Bruno');

      const res = await search(b.member).expect(200);

      expect(summary(res.body as ListItem[])).toEqual([
        ['Reciente', null],
        ['Antigua', null],
      ]);
      expect(res.body[0]).toMatchObject({
        globalPriceList: null,
        addresses: [],
        createdAt: expect.any(String) as string,
      });
      expect(res.body[0]).not.toHaveProperty('pets');
      expect(res.body[0]).not.toHaveProperty('activePetsCount');
    });

    it.each(['', '   '])('search %j is the same as no search', async (q) => {
      const b = await branch('ListaVacia');
      await customer(b, 'Rosa');
      const res = await search(b.member, q).expect(200);
      expect(summary(res.body as ListItem[])).toEqual([['Rosa', null]]);
    });
  });

  describe('GET /customers?search=', () => {
    it('matches an ACTIVE pet name accent- and case-insensitively; matchedPetName is the pet name', async () => {
      const b = await branch('BuscarMascota');
      const owner = await customer(b, 'Rosa');
      await customer(b, 'Pedro');
      await pet(b, owner, 'Brunó');

      const res = await search(b.member, 'BRUNO').expect(200);

      expect(summary(res.body as ListItem[])).toEqual([['Rosa', 'Brunó']]);
      expect(res.body[0].id).toBe(owner);
      expect(res.body[0]).not.toHaveProperty('pets');
    });

    it('does not match an ARCHIVED pet', async () => {
      const b = await branch('BuscarArchivada');
      const owner = await customer(b, 'Rosa');
      await pet(b, owner, 'Bruno', {
        status: 'ARCHIVED',
        archivedAt: new Date(),
      });
      const res = await search(b.member, 'bruno').expect(200);
      expect(res.body).toEqual([]);
    });

    it('matchedPetName is null when the customer matched through its own fields (even if a pet matches too)', async () => {
      const b = await branch('BuscarPropio');
      const bruno = await customer(b, 'Bruno', { lastName: 'Díaz' });
      await pet(b, bruno, 'Bruno');
      const owner = await customer(b, 'Rosa');
      await pet(b, owner, 'Bruno Jr');

      const res = await search(b.member, 'bruno').expect(200);

      expect(summary(res.body as ListItem[]).sort()).toEqual(
        [
          ['Bruno', null],
          ['Rosa', 'Bruno Jr'],
        ].sort(),
      );
    });

    it('matches the customer own fields (name words, e-mail, phone) with matchedPetName null', async () => {
      const b = await branch('BuscarCliente');
      await customer(b, 'Rosa', {
        lastName: 'Pérez',
        phone: '5585876245',
        email: 'rosa@mail.test',
      });
      await customer(b, 'Pedro', { lastName: 'López' });

      const cases: [string, (string | null)[][]][] = [
        ['rosa', [['Rosa', null]]],
        ['ROSA pérez', [['Rosa', null]]],
        ['mail.test', [['Rosa', null]]],
        ['58587', [['Rosa', null]]],
        ['pedro', [['Pedro', null]]],
        // every word must match the same customer
        ['lópez rosa', []],
      ];
      for (const [q, expected] of cases) {
        const res = await search(b.member, q).expect(200);
        expect(summary(res.body as ListItem[])).toEqual(expected);
      }
    });

    it('with several matching pets reports the first by name', async () => {
      const b = await branch('BuscarVarias');
      const owner = await customer(b, 'Rosa');
      await pet(b, owner, 'Max el Grande');
      await pet(b, owner, 'Max');

      const res = await search(b.member, 'max').expect(200);

      expect(summary(res.body as ListItem[])).toEqual([['Rosa', 'Max']]);
    });

    it("never returns another branch's customers or pets", async () => {
      const b = await branch('BuscarAislada');
      const other = await branch('BuscarAislada B');
      const foreign = await customer(other, 'Ajena');
      await pet(other, foreign, 'Bruno');
      const mine = await customer(b, 'Rosa');
      await pet(b, mine, 'Bruno');

      const res = await search(b.member, 'bruno').expect(200);

      expect((res.body as ListItem[]).map((i) => i.id)).toEqual([mine]);
    });

    it('no match → empty list; LIKE wildcards in the term are literal', async () => {
      const b = await branch('BuscarNada');
      const owner = await customer(b, 'Rosa');
      await pet(b, owner, 'Bruno');
      expect((await search(b.member, 'zzz').expect(200)).body).toEqual([]);
      expect((await search(b.member, '%').expect(200)).body).toEqual([]);
      expect((await search(b.member, '_runo').expect(200)).body).toEqual([]);
    });

    it('a repeated ?search= is just a term that matches nothing, never a 500', async () => {
      const b = await branch('BuscarDoble');
      await customer(b, 'Rosa');
      const res = await request(server())
        .get('/customers?search=a&search=b')
        .set(auth(b.member))
        .expect(200);
      expect(res.body).toEqual([]);
    });
  });
});
