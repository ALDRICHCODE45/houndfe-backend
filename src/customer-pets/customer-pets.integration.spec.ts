/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- supertest bodies are untyped JSON */
/**
 * customer-pets / T1 (S1-S5, S9) — the POS routes under
 * `/customers/:customerId/pets` against REAL PostgreSQL with the real JWT →
 * tenant → CASL guard chain and the production validation pipe.
 *
 * Every test asserts the status, the exact error body, the response fields and
 * the database state (unchanged on every rejection).
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
  TEST_JWT_SECRET,
  worldPrisma,
  ZoneWorld,
  type SeededMember,
} from '../delivery-zones/test-support/delivery-zone-world';
import { ConfigService } from '@nestjs/config';
import { CustomerPetsService } from './application/customer-pets.service';
import { CUSTOMER_PET_REPOSITORY } from './domain/customer-pet.repository';
import { PrismaCustomerPetRepository } from './infrastructure/prisma-customer-pet.repository';
import { CustomerPetsController } from './presentation/customer-pets.controller';

const describeIfDb = SKIP_DB_INTEGRATION ? describe.skip : describe;

describeIfDb('customer pets POS routes (PostgreSQL)', () => {
  const prisma = worldPrisma();
  const world = new ZoneWorld();
  let app: INestApplication;
  const server = () => app.getHttpServer() as App;

  interface Branch {
    tenantId: string;
    member: SeededMember;
    readOnly: SeededMember;
    updateOnly: SeededMember;
  }

  beforeAll(async () => {
    app = await createZoneTestApp({
      controllers: [CustomerPetsController],
      providers: [
        CustomerPetsService,
        {
          provide: CUSTOMER_PET_REPOSITORY,
          useClass: PrismaCustomerPetRepository,
        },
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: () => TEST_JWT_SECRET,
            get: (key: string) =>
              key === 'PROMOTIONS_BUSINESS_TIMEZONE'
                ? 'America/Mexico_City'
                : TEST_JWT_SECRET,
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

  async function branch(name: string): Promise<Branch> {
    const tenantId = await world.tenant(name);
    return {
      tenantId,
      member: await world.member(tenantId, `Gerente ${name}`, [
        'Customer:read',
        'Customer:update',
        'Customer:delete',
      ]),
      readOnly: await world.member(tenantId, `Lector ${name}`, [
        'Customer:read',
      ]),
      updateOnly: await world.member(tenantId, `Editor ${name}`, [
        'Customer:read',
        'Customer:update',
      ]),
    };
  }

  async function customer(b: Branch, firstName = 'Rosa'): Promise<string> {
    const id = randomUUID();
    await prisma.customer.create({
      data: { id, tenantId: b.tenantId, firstName },
    });
    return id;
  }

  /** A pet row written straight to the database (nameKey kept in sync). */
  async function seedPet(
    b: Branch,
    customerId: string,
    over: Partial<Prisma.CustomerPetUncheckedCreateInput> = {},
  ) {
    const name = over.name ?? 'Bruno';
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
  const base = (customerId: string) => `/customers/${customerId}/pets`;
  const post = (m: SeededMember, customerId: string, body: object) =>
    request(server()).post(base(customerId)).set(auth(m)).send(body);
  const patch = (
    m: SeededMember,
    customerId: string,
    petId: string,
    body: object,
  ) =>
    request(server())
      .patch(`${base(customerId)}/${petId}`)
      .set(auth(m))
      .send(body);
  const archive = (
    m: SeededMember,
    customerId: string,
    petId: string,
    body: object,
  ) =>
    request(server())
      .post(`${base(customerId)}/${petId}/archive`)
      .set(auth(m))
      .send(body);
  const restore = (
    m: SeededMember,
    customerId: string,
    petId: string,
    body: object,
  ) =>
    request(server())
      .post(`${base(customerId)}/${petId}/restore`)
      .set(auth(m))
      .send(body);
  const list = (m: SeededMember, customerId: string, query = '') =>
    request(server())
      .get(`${base(customerId)}${query}`)
      .set(auth(m));
  const del = (
    m: SeededMember,
    customerId: string,
    petId: string,
    query = '',
  ) =>
    request(server())
      .delete(`${base(customerId)}/${petId}${query}`)
      .set(auth(m));

  const petRow = (id: string) =>
    prisma.customerPet.findUnique({ where: { id } });
  const petCount = (customerId: string, status?: 'ACTIVE' | 'ARCHIVED') =>
    prisma.customerPet.count({
      where: { customerId, ...(status ? { status } : {}) },
    });

  const errorBody = (statusCode: number, code: string, extra: object = {}) => ({
    statusCode,
    error: code,
    message: code,
    ...extra,
  });
  const invalidFields = (res: request.Response): string[] =>
    (res.body.message as { property: string }[]).map((m) => m.property);

  // ───────────────────────── S1 + S2 + S3 create ─────────────────────────

  describe('POST /customers/:customerId/pets', () => {
    it('201 with the complete pet of §2 + warnings [], version 1, createdVia POS', async () => {
      const b = await branch('Crear');
      const c = await customer(b);

      const res = await post(b.member, c, {
        name: '  Bruno ',
        species: 'DOG',
        breed: 'Chihuahua',
        size: 'SMALL',
        allergies: 'Pollo',
      }).expect(201);

      expect(res.body).toEqual({
        id: expect.any(String) as string,
        customerId: c,
        name: 'Bruno',
        species: 'DOG',
        speciesOther: null,
        breed: 'Chihuahua',
        size: 'SMALL',
        birthDate: null,
        birthDatePrecision: null,
        ageMonths: null,
        ageLabel: null,
        allergies: 'Pollo',
        notes: null,
        status: 'ACTIVE',
        archivedAt: null,
        archivedReason: null,
        createdVia: 'POS',
        version: 1,
        createdAt: expect.any(String) as string,
        updatedAt: expect.any(String) as string,
        warnings: [],
      });
      const row = await petRow(res.body.id);
      expect(row).toMatchObject({
        tenantId: b.tenantId,
        customerId: c,
        name: 'Bruno',
        nameKey: 'bruno',
        status: 'ACTIVE',
        createdVia: 'POS',
        version: 1,
      });
    });

    it('approxAge {months:10} → MONTH date on day 01 with ageMonths 10 and «~10 meses» in the write response', async () => {
      const b = await branch('Edad');
      const c = await customer(b);

      const res = await post(b.member, c, {
        name: 'Bruno',
        species: 'DOG',
        approxAge: { months: 10 },
      }).expect(201);

      expect(res.body).toMatchObject({
        birthDatePrecision: 'MONTH',
        ageMonths: 10,
        ageLabel: '~10 meses',
      });
      expect(res.body.birthDate).toMatch(/^\d{4}-\d{2}-01$/);
      const row = await petRow(res.body.id);
      expect(row?.birthDate?.toISOString().slice(0, 10)).toBe(
        res.body.birthDate,
      );
      expect(row?.birthDatePrecision).toBe('MONTH');
    });

    it('approxAge {years:3} → January 1, YEAR; EXACT date keeps its day and label has no «~»', async () => {
      const b = await branch('Edad2');
      const c = await customer(b);

      const years = await post(b.member, c, {
        name: 'A',
        species: 'CAT',
        approxAge: { years: 3 },
      }).expect(201);
      expect(years.body.birthDate).toMatch(/^\d{4}-01-01$/);
      expect(years.body.birthDatePrecision).toBe('YEAR');
      expect(years.body.ageLabel).toMatch(/^~\d+ años?( \d+ meses?)?$/);

      const exact = await post(b.member, c, {
        name: 'B',
        species: 'CAT',
        birthDate: '2020-03-15',
        birthDatePrecision: 'EXACT',
      }).expect(201);
      expect(exact.body.birthDate).toBe('2020-03-15');
      expect(exact.body.ageLabel).not.toContain('~');
      expect(exact.body.ageMonths).toBeGreaterThanOrEqual(12 * 6);
    });

    it.each([
      ['missing name', { species: 'DOG' }, ['name']],
      ['name > 60', { name: 'a'.repeat(61), species: 'DOG' }, ['name']],
      ['bad species', { name: 'Max', species: 'BIRD' }, ['species']],
      [
        'OTHER without speciesOther',
        { name: 'Max', species: 'OTHER' },
        ['speciesOther'],
      ],
      [
        'speciesOther on a DOG',
        { name: 'Max', species: 'DOG', speciesOther: 'Conejo' },
        ['speciesOther'],
      ],
      [
        'precision without date',
        { name: 'Max', species: 'DOG', birthDatePrecision: 'EXACT' },
        ['birthDatePrecision'],
      ],
      [
        'date without precision',
        { name: 'Max', species: 'DOG', birthDate: '2020-01-01' },
        ['birthDatePrecision'],
      ],
      [
        'future birthDate',
        {
          name: 'Max',
          species: 'DOG',
          birthDate: '2999-01-01',
          birthDatePrecision: 'EXACT',
        },
        ['birthDate'],
      ],
      [
        'approxAge with birthDate',
        {
          name: 'Max',
          species: 'DOG',
          birthDate: '2020-01-01',
          birthDatePrecision: 'EXACT',
          approxAge: { months: 3 },
        },
        ['approxAge'],
      ],
      [
        'unknown property',
        { name: 'Max', species: 'DOG', status: 'ARCHIVED' },
        ['status'],
      ],
    ])('400 per-field for %s, nothing stored', async (_n, body, fields) => {
      const b = await branch('Validacion');
      const c = await customer(b);

      const res = await post(b.member, c, body).expect(400);

      expect(res.body.statusCode).toBe(400);
      expect(invalidFields(res)).toEqual(fields);
      expect(await petCount(c)).toBe(0);
    });

    it('warns PET_NAME_DUPLICATE (accent/case/space-insensitive) and still creates', async () => {
      const b = await branch('Duplicados');
      const c = await customer(b);
      const first = await post(b.member, c, {
        name: 'Bruno',
        species: 'DOG',
      }).expect(201);
      expect(first.body.warnings).toEqual([]);

      const second = await post(b.member, c, {
        name: '  BRUNÓ  ',
        species: 'CAT',
      }).expect(201);

      expect(second.body.warnings).toEqual(['PET_NAME_DUPLICATE']);
      expect(second.body.id).not.toBe(first.body.id);
      expect(await petCount(c, 'ACTIVE')).toBe(2);
    });

    it('does not warn for the same name on another customer or on an ARCHIVED pet', async () => {
      const b = await branch('SinDup');
      const c = await customer(b);
      const other = await customer(b, 'Pedro');
      await seedPet(b, other, { name: 'Bruno' });
      await seedPet(b, c, {
        name: 'Bruno',
        status: 'ARCHIVED',
        archivedAt: new Date(),
      });

      const res = await post(b.member, c, {
        name: 'Bruno',
        species: 'DOG',
      }).expect(201);

      expect(res.body.warnings).toEqual([]);
    });

    it('unknown customer → 404 CUSTOMER_NOT_FOUND', async () => {
      const b = await branch('NoCliente');
      const res = await post(b.member, randomUUID(), {
        name: 'Max',
        species: 'DOG',
      }).expect(404);
      expect(res.body).toEqual(errorBody(404, 'CUSTOMER_NOT_FOUND'));
    });

    it('a customer of another branch → 404 CUSTOMER_NOT_FOUND and nothing stored', async () => {
      const a = await branch('Rama A');
      const other = await branch('Rama B');
      const foreign = await customer(other);

      const res = await post(a.member, foreign, {
        name: 'Max',
        species: 'DOG',
      }).expect(404);

      expect(res.body).toEqual(errorBody(404, 'CUSTOMER_NOT_FOUND'));
      expect(await petCount(foreign)).toBe(0);
    });
  });

  // ───────────────────────── S1 limit + lock ─────────────────────────

  describe('limit of 20 ACTIVE pets', () => {
    const seedMany = (
      b: Branch,
      customerId: string,
      n: number,
      status: 'ACTIVE' | 'ARCHIVED' = 'ACTIVE',
    ) =>
      prisma.customerPet.createMany({
        data: Array.from({ length: n }, (_v, i) => ({
          tenantId: b.tenantId,
          customerId,
          name: `${status}-${i}`,
          nameKey: `${status.toLowerCase()}-${i}`,
          species: 'DOG' as const,
          createdVia: 'POS' as const,
          status,
          ...(status === 'ARCHIVED' ? { archivedAt: new Date() } : {}),
        })),
      });

    it('the 21st ACTIVE pet → 422 PET_LIMIT_REACHED, still 20 rows', async () => {
      const b = await branch('Tope');
      const c = await customer(b);
      await seedMany(b, c, 20);

      const res = await post(b.member, c, {
        name: 'Extra',
        species: 'DOG',
      }).expect(422);

      expect(res.body).toEqual(errorBody(422, 'PET_LIMIT_REACHED'));
      expect(await petCount(c)).toBe(20);
    });

    it('the 20th is accepted and archived pets do not count', async () => {
      const b = await branch('Tope2');
      const c = await customer(b);
      await seedMany(b, c, 19);
      await seedMany(b, c, 30, 'ARCHIVED');

      await post(b.member, c, { name: 'Veinte', species: 'DOG' }).expect(201);

      expect(await petCount(c, 'ACTIVE')).toBe(20);
      expect(await petCount(c, 'ARCHIVED')).toBe(30);
    });

    it('the limit is per customer', async () => {
      const b = await branch('Tope3');
      const full = await customer(b);
      const empty = await customer(b, 'Otro');
      await seedMany(b, full, 20);

      await post(b.member, empty, { name: 'Max', species: 'DOG' }).expect(201);
    });

    it('restoring past the limit → 422 PET_LIMIT_REACHED, pet stays ARCHIVED at the same version', async () => {
      const b = await branch('TopeRestore');
      const c = await customer(b);
      await seedMany(b, c, 20);
      const archived = await seedPet(b, c, {
        name: 'Viejo',
        status: 'ARCHIVED',
        archivedAt: new Date(),
        archivedReason: 'x',
        version: 4,
      });

      const res = await restore(b.member, c, archived.id, {
        version: 4,
      }).expect(422);

      expect(res.body).toEqual(errorBody(422, 'PET_LIMIT_REACHED'));
      expect(await petRow(archived.id)).toMatchObject({
        status: 'ARCHIVED',
        version: 4,
        archivedReason: 'x',
      });
    });

    it('concurrent creates cannot pass the limit (customer row lock)', async () => {
      const b = await branch('Concurrente');
      const c = await customer(b);
      await seedMany(b, c, 18);

      const results = await Promise.all(
        Array.from({ length: 6 }, (_v, i) =>
          post(b.member, c, { name: `Carrera ${i}`, species: 'DOG' }),
        ),
      );

      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 201, 422, 422, 422, 422]);
      for (const r of results.filter((x) => x.status === 422)) {
        expect(r.body).toEqual(errorBody(422, 'PET_LIMIT_REACHED'));
      }
      expect(await petCount(c, 'ACTIVE')).toBe(20);
    });
  });

  // ───────────────────────── S3 PATCH / archive / restore ─────────────────────────

  describe('PATCH /customers/:customerId/pets/:petId', () => {
    it('absent = unchanged, value sets, version +1, derived age in the response', async () => {
      const b = await branch('Patch');
      const c = await customer(b);
      const pet = await seedPet(b, c, {
        name: 'Bruno',
        breed: 'Chihuahua',
        allergies: 'Pollo',
        notes: 'Nervioso',
        size: 'SMALL',
        birthDate: new Date('2024-03-01T00:00:00.000Z'),
        birthDatePrecision: 'MONTH',
      });

      const res = await patch(b.member, c, pet.id, {
        version: 1,
        breed: 'Poodle',
      }).expect(200);

      expect(res.body).toMatchObject({
        id: pet.id,
        name: 'Bruno',
        breed: 'Poodle',
        allergies: 'Pollo',
        notes: 'Nervioso',
        size: 'SMALL',
        birthDate: '2024-03-01',
        birthDatePrecision: 'MONTH',
        version: 2,
        warnings: [],
      });
      expect(res.body.ageMonths).toBeGreaterThanOrEqual(1);
      expect(res.body.ageLabel).toMatch(/^~/);
      const row = await petRow(pet.id);
      expect(row).toMatchObject({
        breed: 'Poodle',
        allergies: 'Pollo',
        version: 2,
      });
      expect(row!.updatedAt.getTime()).toBeGreaterThanOrEqual(
        pet.updatedAt.getTime(),
      );
    });

    it('null clears allergies, notes, breed, size and the birth date with its precision', async () => {
      const b = await branch('PatchNull');
      const c = await customer(b);
      const pet = await seedPet(b, c, {
        breed: 'x',
        allergies: 'Pollo',
        notes: 'n',
        size: 'LARGE',
        birthDate: new Date('2024-03-01T00:00:00.000Z'),
        birthDatePrecision: 'MONTH',
      });

      const res = await patch(b.member, c, pet.id, {
        version: 1,
        breed: null,
        allergies: null,
        notes: null,
        size: null,
        birthDate: null,
      }).expect(200);

      expect(res.body).toMatchObject({
        breed: null,
        allergies: null,
        notes: null,
        size: null,
        birthDate: null,
        birthDatePrecision: null,
        ageMonths: null,
        ageLabel: null,
        version: 2,
      });
      expect(await petRow(pet.id)).toMatchObject({
        breed: null,
        allergies: null,
        notes: null,
        size: null,
        birthDate: null,
        birthDatePrecision: null,
      });
    });

    it('approxAge replaces the date; OTHER → DOG clears speciesOther', async () => {
      const b = await branch('PatchAprox');
      const c = await customer(b);
      const pet = await seedPet(b, c, {
        species: 'OTHER',
        speciesOther: 'Conejo',
      });

      const res = await patch(b.member, c, pet.id, {
        version: 1,
        species: 'DOG',
        approxAge: { years: 1, months: 4 },
      }).expect(200);

      expect(res.body).toMatchObject({
        species: 'DOG',
        speciesOther: null,
        birthDatePrecision: 'MONTH',
        ageMonths: 16,
        ageLabel: '~1 año 4 meses',
      });
    });

    it.each([
      ['null name', { name: null }, ['name']],
      ['blank name', { name: '  ' }, ['name']],
      ['null species', { species: null }, ['species']],
      ['missing version', { breed: 'x' }, ['version']],
      [
        'approxAge with birthDate',
        {
          birthDate: '2020-01-01',
          birthDatePrecision: 'EXACT',
          approxAge: { months: 1 },
        },
        ['approxAge'],
      ],
      [
        'future birthDate',
        { birthDate: '2999-01-01', birthDatePrecision: 'EXACT' },
        ['birthDate'],
      ],
    ])('400 per-field for %s, row unchanged', async (name, body, fields) => {
      const b = await branch('PatchVal');
      const c = await customer(b);
      const pet = await seedPet(b, c);

      const payload =
        name === 'missing version' ? body : { version: 1, ...body };
      const res = await patch(b.member, c, pet.id, payload).expect(400);

      expect(invalidFields(res)).toEqual(fields);
      expect(await petRow(pet.id)).toMatchObject({ name: 'Bruno', version: 1 });
    });

    it('stale version → 409 PET_VERSION_CONFLICT with currentVersion at the root, row unchanged', async () => {
      const b = await branch('PatchConf');
      const c = await customer(b);
      const pet = await seedPet(b, c, { version: 3, breed: 'A' });

      const res = await patch(b.member, c, pet.id, {
        version: 2,
        breed: 'B',
      }).expect(409);

      expect(res.body).toEqual(
        errorBody(409, 'PET_VERSION_CONFLICT', { currentVersion: 3 }),
      );
      expect(await petRow(pet.id)).toMatchObject({ breed: 'A', version: 3 });
    });

    it('two concurrent PATCH with the same version: one wins, the other gets the new currentVersion', async () => {
      const b = await branch('PatchRace');
      const c = await customer(b);
      const pet = await seedPet(b, c);

      const [r1, r2] = await Promise.all([
        patch(b.member, c, pet.id, { version: 1, breed: 'Uno' }),
        patch(b.member, c, pet.id, { version: 1, breed: 'Dos' }),
      ]);

      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toEqual([200, 409]);
      const loser = r1.status === 409 ? r1 : r2;
      expect(loser.body).toEqual(
        errorBody(409, 'PET_VERSION_CONFLICT', { currentVersion: 2 }),
      );
      expect((await petRow(pet.id))!.version).toBe(2);
    });

    it('changing the name to one another ACTIVE pet has → warnings; same name again → none', async () => {
      const b = await branch('PatchDup');
      const c = await customer(b);
      await seedPet(b, c, { name: 'Max' });
      const bruno = await seedPet(b, c, { name: 'Bruno' });

      const renamed = await patch(b.member, c, bruno.id, {
        version: 1,
        name: 'MAX',
      }).expect(200);
      expect(renamed.body.warnings).toEqual(['PET_NAME_DUPLICATE']);
      expect(renamed.body.name).toBe('MAX');

      const same = await patch(b.member, c, bruno.id, {
        version: 2,
        name: 'MAX',
      }).expect(200);
      expect(same.body.warnings).toEqual([]);
    });

    it('PATCH on an ARCHIVED pet → 422 PET_ARCHIVED, row unchanged', async () => {
      const b = await branch('PatchArch');
      const c = await customer(b);
      const pet = await seedPet(b, c, {
        status: 'ARCHIVED',
        archivedAt: new Date(),
      });

      const res = await patch(b.member, c, pet.id, {
        version: 1,
        breed: 'x',
      }).expect(422);

      expect(res.body).toEqual(errorBody(422, 'PET_ARCHIVED'));
      expect(await petRow(pet.id)).toMatchObject({ breed: null, version: 1 });
    });

    it('unknown pet, a pet of another customer and a pet of another branch → 404 PET_NOT_FOUND', async () => {
      const b = await branch('Patch404');
      const other = await branch('Patch404 B');
      const c = await customer(b);
      const sibling = await customer(b, 'Pedro');
      const siblingPet = await seedPet(b, sibling);
      const foreignCustomer = await customer(other);
      const foreignPet = await seedPet(other, foreignCustomer);

      for (const id of [randomUUID(), siblingPet.id, foreignPet.id]) {
        const res = await patch(b.member, c, id, {
          version: 1,
          breed: 'x',
        }).expect(404);
        expect(res.body).toEqual(errorBody(404, 'PET_NOT_FOUND'));
      }
      expect((await petRow(siblingPet.id))!.breed).toBeNull();
      expect((await petRow(foreignPet.id))!.breed).toBeNull();
    });

    it('unknown customer → 404 CUSTOMER_NOT_FOUND', async () => {
      const b = await branch('Patch404C');
      const res = await patch(b.member, randomUUID(), randomUUID(), {
        version: 1,
      }).expect(404);
      expect(res.body).toEqual(errorBody(404, 'CUSTOMER_NOT_FOUND'));
    });
  });

  describe('archive / restore', () => {
    it('archive: 200, ARCHIVED with archivedAt and reason, version +1, complete pet', async () => {
      const b = await branch('Archivar');
      const c = await customer(b);
      const pet = await seedPet(b, c, { name: 'Bruno', version: 2 });

      const res = await archive(b.member, c, pet.id, {
        version: 2,
        reason: ' Ya no está ',
      }).expect(200);

      expect(res.body).toMatchObject({
        id: pet.id,
        status: 'ARCHIVED',
        archivedAt: expect.any(String) as string,
        archivedReason: 'Ya no está',
        version: 3,
        warnings: [],
      });
      expect(await petRow(pet.id)).toMatchObject({
        status: 'ARCHIVED',
        archivedReason: 'Ya no está',
        version: 3,
      });
    });

    it('archive without a reason stores null; reason > 280 → 400; missing version → 400', async () => {
      const b = await branch('ArchivarVal');
      const c = await customer(b);
      const pet = await seedPet(b, c);

      const bad = await archive(b.member, c, pet.id, {
        version: 1,
        reason: 'x'.repeat(281),
      }).expect(400);
      expect(invalidFields(bad)).toEqual(['reason']);
      const noVersion = await archive(b.member, c, pet.id, {}).expect(400);
      expect(invalidFields(noVersion)).toEqual(['version']);
      expect(await petRow(pet.id)).toMatchObject({
        status: 'ACTIVE',
        version: 1,
      });

      await archive(b.member, c, pet.id, { version: 1 }).expect(200);
      expect(await petRow(pet.id)).toMatchObject({
        status: 'ARCHIVED',
        archivedReason: null,
      });
    });

    it('archiving an archived pet → 422 PET_ARCHIVED; stale version → 409 with currentVersion', async () => {
      const b = await branch('ArchivarErr');
      const c = await customer(b);
      const pet = await seedPet(b, c, { version: 5 });

      const stale = await archive(b.member, c, pet.id, { version: 4 }).expect(
        409,
      );
      expect(stale.body).toEqual(
        errorBody(409, 'PET_VERSION_CONFLICT', { currentVersion: 5 }),
      );
      expect((await petRow(pet.id))!.status).toBe('ACTIVE');

      await archive(b.member, c, pet.id, { version: 5 }).expect(200);
      const again = await archive(b.member, c, pet.id, { version: 6 }).expect(
        422,
      );
      expect(again.body).toEqual(errorBody(422, 'PET_ARCHIVED'));
      expect((await petRow(pet.id))!.version).toBe(6);
    });

    it('restore: ARCHIVED → ACTIVE, archivedAt/reason cleared, version +1; duplicate name warns', async () => {
      const b = await branch('Restaurar');
      const c = await customer(b);
      await seedPet(b, c, { name: 'Bruno' });
      const pet = await seedPet(b, c, {
        name: 'Bruno',
        status: 'ARCHIVED',
        archivedAt: new Date(),
        archivedReason: 'x',
      });

      const res = await restore(b.member, c, pet.id, { version: 1 }).expect(
        200,
      );

      expect(res.body).toMatchObject({
        status: 'ACTIVE',
        archivedAt: null,
        archivedReason: null,
        version: 2,
        warnings: ['PET_NAME_DUPLICATE'],
      });
      expect(await petRow(pet.id)).toMatchObject({
        status: 'ACTIVE',
        archivedAt: null,
        archivedReason: null,
        version: 2,
      });
    });

    it('restoring an ACTIVE pet → 422 PET_NOT_ARCHIVED; stale → 409; extra field → 400', async () => {
      const b = await branch('RestaurarErr');
      const c = await customer(b);
      const pet = await seedPet(b, c, { version: 2 });

      const active = await restore(b.member, c, pet.id, { version: 2 }).expect(
        422,
      );
      expect(active.body).toEqual(errorBody(422, 'PET_NOT_ARCHIVED'));
      const stale = await restore(b.member, c, pet.id, { version: 1 }).expect(
        409,
      );
      expect(stale.body).toEqual(
        errorBody(409, 'PET_VERSION_CONFLICT', { currentVersion: 2 }),
      );
      const extra = await restore(b.member, c, pet.id, {
        version: 2,
        reason: 'x',
      }).expect(400);
      expect(invalidFields(extra)).toEqual(['reason']);
      expect(await petRow(pet.id)).toMatchObject({
        status: 'ACTIVE',
        version: 2,
      });
    });
  });

  // ───────────────────────── S4 list ─────────────────────────

  describe('GET /customers/:customerId/pets', () => {
    it('default ACTIVE sorted by name (accents folded); ARCHIVED by archivedAt desc; ALL newest first', async () => {
      const b = await branch('Listar');
      const c = await customer(b);
      const t = (n: number) => new Date(Date.UTC(2026, 0, n));
      await seedPet(b, c, { name: 'Zeus', createdAt: t(1) });
      await seedPet(b, c, { name: 'Álvaro', createdAt: t(2) });
      await seedPet(b, c, { name: 'Max', createdAt: t(3) });
      await seedPet(b, c, {
        name: 'Viejo1',
        status: 'ARCHIVED',
        archivedAt: t(10),
        createdAt: t(4),
      });
      await seedPet(b, c, {
        name: 'Viejo2',
        status: 'ARCHIVED',
        archivedAt: t(20),
        createdAt: t(5),
      });

      const active = await list(b.readOnly, c).expect(200);
      expect(active.body.map((p: { name: string }) => p.name)).toEqual([
        'Álvaro',
        'Max',
        'Zeus',
      ]);
      const explicit = await list(b.readOnly, c, '?status=ACTIVE').expect(200);
      expect(explicit.body).toEqual(active.body);

      const archived = await list(b.readOnly, c, '?status=ARCHIVED').expect(
        200,
      );
      expect(archived.body.map((p: { name: string }) => p.name)).toEqual([
        'Viejo2',
        'Viejo1',
      ]);

      const all = await list(b.readOnly, c, '?status=ALL').expect(200);
      expect(all.body.map((p: { name: string }) => p.name)).toEqual([
        'Viejo2',
        'Viejo1',
        'Max',
        'Álvaro',
        'Zeus',
      ]);
    });

    it('items carry the §2 shape with derived age and no tenantId/nameKey/warnings', async () => {
      const b = await branch('ListarForma');
      const c = await customer(b);
      await seedPet(b, c, {
        name: 'Bruno',
        birthDate: new Date('2024-03-01T00:00:00.000Z'),
        birthDatePrecision: 'MONTH',
      });

      const res = await list(b.readOnly, c).expect(200);

      expect(res.body).toHaveLength(1);
      const pet = res.body[0];
      expect(Object.keys(pet).sort()).toEqual(
        [
          'id',
          'customerId',
          'name',
          'species',
          'speciesOther',
          'breed',
          'size',
          'birthDate',
          'birthDatePrecision',
          'ageMonths',
          'ageLabel',
          'allergies',
          'notes',
          'status',
          'archivedAt',
          'archivedReason',
          'createdVia',
          'version',
          'createdAt',
          'updatedAt',
        ].sort(),
      );
      expect(pet.birthDate).toBe('2024-03-01');
      expect(pet.ageLabel).toMatch(/^~/);
    });

    it('ALL and ARCHIVED are capped at 100 rows', async () => {
      const b = await branch('ListarTope');
      const c = await customer(b);
      await prisma.customerPet.createMany({
        data: Array.from({ length: 105 }, (_v, i) => ({
          tenantId: b.tenantId,
          customerId: c,
          name: `P${i}`,
          nameKey: `p${i}`,
          species: 'DOG' as const,
          createdVia: 'POS' as const,
          status: 'ARCHIVED' as const,
          archivedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
        })),
      });

      expect(
        (await list(b.readOnly, c, '?status=ALL').expect(200)).body,
      ).toHaveLength(100);
      expect(
        (await list(b.readOnly, c, '?status=ARCHIVED').expect(200)).body,
      ).toHaveLength(100);
      expect((await list(b.readOnly, c).expect(200)).body).toEqual([]);
    });

    it('invalid status → 400; unknown customer → 404 CUSTOMER_NOT_FOUND; other branch → 404; only own pets', async () => {
      const b = await branch('ListarErr');
      const other = await branch('ListarErr B');
      const c = await customer(b);
      const sibling = await customer(b, 'Pedro');
      await seedPet(b, sibling, { name: 'Ajeno' });
      const foreign = await customer(other);
      await seedPet(other, foreign);

      const bad = await list(b.readOnly, c, '?status=DELETED').expect(400);
      expect(invalidFields(bad)).toEqual(['status']);
      const unknown = await list(b.readOnly, randomUUID()).expect(404);
      expect(unknown.body).toEqual(errorBody(404, 'CUSTOMER_NOT_FOUND'));
      const cross = await list(b.readOnly, foreign).expect(404);
      expect(cross.body).toEqual(errorBody(404, 'CUSTOMER_NOT_FOUND'));
      expect((await list(b.readOnly, c).expect(200)).body).toEqual([]);
    });
  });

  // ───────────────────────── S5 forgetting ─────────────────────────

  describe('DELETE /customers/:customerId/pets/:petId?version=N', () => {
    async function seedSale(
      b: Branch,
      customerId: string,
      petId: string | null,
    ) {
      const productId = randomUUID();
      await prisma.product.create({
        data: {
          id: productId,
          tenantId: b.tenantId,
          name: 'Croquetas',
          useStock: false,
        },
      });
      const sale = await prisma.sale.create({
        data: {
          tenantId: b.tenantId,
          userId: b.member.userId,
          customerId,
          status: 'CONFIRMED',
          subtotalCents: 30000,
          totalCents: 30000,
          paidCents: 30000,
        },
      });
      const withPet = await prisma.saleItem.create({
        data: {
          tenantId: b.tenantId,
          saleId: sale.id,
          productId,
          productName: 'Croquetas',
          quantity: 2,
          unitPriceCents: 10000,
          petId,
          petNameSnapshot: petId ? 'Bruno' : null,
          petSpeciesSnapshot: petId ? 'DOG' : null,
        },
      });
      const withoutPet = await prisma.saleItem.create({
        data: {
          tenantId: b.tenantId,
          saleId: sale.id,
          productId,
          productName: 'Juguete',
          quantity: 1,
          unitPriceCents: 10000,
        },
      });
      return { productId, sale, withPet, withoutPet };
    }

    it('204, empty body: pet deleted and its sale lines scrubbed in one go; lines, product and amounts stay', async () => {
      const b = await branch('Borrar');
      const c = await customer(b);
      const pet = await seedPet(b, c, { name: 'Bruno', version: 3 });
      const other = await seedPet(b, c, { name: 'Max' });
      const { productId, sale, withPet, withoutPet } = await seedSale(
        b,
        c,
        pet.id,
      );

      const res = await del(b.member, c, pet.id, '?version=3').expect(204);

      expect(res.text).toBe('');
      expect(await petRow(pet.id)).toBeNull();
      expect(await petRow(other.id)).not.toBeNull();
      const line = await prisma.saleItem.findUnique({
        where: { id: withPet.id },
      });
      expect(line).toMatchObject({
        petId: null,
        petNameSnapshot: null,
        petSpeciesSnapshot: null,
        productId,
        productName: 'Croquetas',
        quantity: 2,
        unitPriceCents: 10000,
        saleId: sale.id,
      });
      expect(
        await prisma.saleItem.findUnique({ where: { id: withoutPet.id } }),
      ).toMatchObject({
        petId: null,
        productName: 'Juguete',
        quantity: 1,
        unitPriceCents: 10000,
      });
      expect(
        await prisma.sale.findUnique({ where: { id: sale.id } }),
      ).toMatchObject({
        totalCents: 30000,
        subtotalCents: 30000,
        paidCents: 30000,
        customerId: c,
        status: 'CONFIRMED',
      });
      expect(await prisma.product.count({ where: { id: productId } })).toBe(1);
    });

    it("scrubs lines of every sale of that pet and leaves other pets' lines intact", async () => {
      const b = await branch('BorrarVarias');
      const c = await customer(b);
      const bruno = await seedPet(b, c, { name: 'Bruno' });
      const max = await seedPet(b, c, { name: 'Max' });
      const s1 = await seedSale(b, c, bruno.id);
      const s2 = await seedSale(b, c, max.id);

      await del(b.member, c, bruno.id, '?version=1').expect(204);

      expect(
        (await prisma.saleItem.findUnique({ where: { id: s1.withPet.id } }))!
          .petNameSnapshot,
      ).toBeNull();
      expect(
        await prisma.saleItem.findUnique({ where: { id: s2.withPet.id } }),
      ).toMatchObject({
        petId: max.id,
        petNameSnapshot: 'Bruno',
        petSpeciesSnapshot: 'DOG',
      });
    });

    it('an ARCHIVED pet can be erased too', async () => {
      const b = await branch('BorrarArch');
      const c = await customer(b);
      const pet = await seedPet(b, c, {
        status: 'ARCHIVED',
        archivedAt: new Date(),
      });
      await del(b.member, c, pet.id, '?version=1').expect(204);
      expect(await petRow(pet.id)).toBeNull();
    });

    it('stale version → 409 with currentVersion; pet and snapshots untouched', async () => {
      const b = await branch('BorrarConf');
      const c = await customer(b);
      const pet = await seedPet(b, c, { version: 4 });
      const { withPet } = await seedSale(b, c, pet.id);

      const res = await del(b.member, c, pet.id, '?version=3').expect(409);

      expect(res.body).toEqual(
        errorBody(409, 'PET_VERSION_CONFLICT', { currentVersion: 4 }),
      );
      expect(await petRow(pet.id)).not.toBeNull();
      expect(
        await prisma.saleItem.findUnique({ where: { id: withPet.id } }),
      ).toMatchObject({
        petId: pet.id,
        petNameSnapshot: 'Bruno',
        petSpeciesSnapshot: 'DOG',
      });
    });

    it.each([
      ['missing', ''],
      ['not an integer', '?version=abc'],
      ['decimal', '?version=1.5'],
      ['empty', '?version='],
      ['zero', '?version=0'],
    ])('version %s → 400 on version, nothing deleted', async (_n, query) => {
      const b = await branch('BorrarVal');
      const c = await customer(b);
      const pet = await seedPet(b, c);
      const { withPet } = await seedSale(b, c, pet.id);

      const res = await del(b.member, c, pet.id, query).expect(400);

      expect(invalidFields(res)).toEqual(['version']);
      expect(await petRow(pet.id)).not.toBeNull();
      expect(
        (await prisma.saleItem.findUnique({ where: { id: withPet.id } }))!
          .petId,
      ).toBe(pet.id);
    });

    it('a body is ignored: only the query version counts', async () => {
      const b = await branch('BorrarBody');
      const c = await customer(b);
      const pet = await seedPet(b, c, { version: 2 });
      await request(server())
        .delete(`${base(c)}/${pet.id}?version=1`)
        .set(auth(b.member))
        .send({ version: 2 })
        .expect(409);
      expect(await petRow(pet.id)).not.toBeNull();
    });

    it('already deleted → 404 PET_NOT_FOUND', async () => {
      const b = await branch('BorrarDos');
      const c = await customer(b);
      const pet = await seedPet(b, c);
      await del(b.member, c, pet.id, '?version=1').expect(204);

      const again = await del(b.member, c, pet.id, '?version=1').expect(404);

      expect(again.body).toEqual(errorBody(404, 'PET_NOT_FOUND'));
    });

    it('a pet of another customer / branch → 404 and untouched; unknown customer → CUSTOMER_NOT_FOUND', async () => {
      const b = await branch('Borrar404');
      const other = await branch('Borrar404 B');
      const c = await customer(b);
      const sibling = await customer(b, 'Pedro');
      const siblingPet = await seedPet(b, sibling);
      const foreignCustomer = await customer(other);
      const foreignPet = await seedPet(other, foreignCustomer);
      const { withPet } = await seedSale(other, foreignCustomer, foreignPet.id);

      for (const id of [siblingPet.id, foreignPet.id]) {
        const res = await del(b.member, c, id, '?version=1').expect(404);
        expect(res.body).toEqual(errorBody(404, 'PET_NOT_FOUND'));
      }
      const cross = await del(
        b.member,
        foreignCustomer,
        foreignPet.id,
        '?version=1',
      ).expect(404);
      expect(cross.body).toEqual(errorBody(404, 'CUSTOMER_NOT_FOUND'));
      const unknown = await del(
        b.member,
        randomUUID(),
        randomUUID(),
        '?version=1',
      ).expect(404);
      expect(unknown.body).toEqual(errorBody(404, 'CUSTOMER_NOT_FOUND'));
      expect(await petRow(siblingPet.id)).not.toBeNull();
      expect(await petRow(foreignPet.id)).not.toBeNull();
      expect(
        (await prisma.saleItem.findUnique({ where: { id: withPet.id } }))!
          .petId,
      ).toBe(foreignPet.id);
    });
  });

  // ───────────────────────── guards ─────────────────────────

  describe('authentication and CASL', () => {
    it('401 without a token on every route', async () => {
      const id = randomUUID();
      const anon = request(server());
      await anon.get(base(id)).expect(401);
      await anon.post(base(id)).send({}).expect(401);
      await anon
        .patch(`${base(id)}/${id}`)
        .send({})
        .expect(401);
      await anon
        .post(`${base(id)}/${id}/archive`)
        .send({})
        .expect(401);
      await anon
        .post(`${base(id)}/${id}/restore`)
        .send({})
        .expect(401);
      await anon.delete(`${base(id)}/${id}?version=1`).expect(401);
    });

    it('read-only: GET ok, every write 403 and nothing changes', async () => {
      const b = await branch('Permisos');
      const c = await customer(b);
      const pet = await seedPet(b, c);

      await list(b.readOnly, c).expect(200);
      await post(b.readOnly, c, { name: 'Max', species: 'DOG' }).expect(403);
      await patch(b.readOnly, c, pet.id, { version: 1, breed: 'x' }).expect(
        403,
      );
      await archive(b.readOnly, c, pet.id, { version: 1 }).expect(403);
      await restore(b.readOnly, c, pet.id, { version: 1 }).expect(403);
      await del(b.readOnly, c, pet.id, '?version=1').expect(403);

      expect(await petCount(c)).toBe(1);
      expect(await petRow(pet.id)).toMatchObject({
        version: 1,
        breed: null,
        status: 'ACTIVE',
      });
    });

    it('update:Customer cannot erase (delete:Customer needed) but can write', async () => {
      const b = await branch('PermisosDel');
      const c = await customer(b);
      const pet = await seedPet(b, c);

      await del(b.updateOnly, c, pet.id, '?version=1').expect(403);
      expect(await petRow(pet.id)).not.toBeNull();
      await patch(b.updateOnly, c, pet.id, { version: 1, breed: 'x' }).expect(
        200,
      );
    });

    it('a malformed id is a 400 like the customer routes', async () => {
      const b = await branch('Uuid');
      await list(b.member, 'no-uuid').expect(400);
      const c = await customer(b);
      await patch(b.member, c, 'no-uuid', { version: 1 }).expect(400);
    });
  });

  // ───────────────────────── model (S1, contract §6 last bullet) ─────────────────────────

  describe('schema', () => {
    it('deleting the customer cascades to its pets; sale lines keep the snapshot with petId NULL', async () => {
      const b = await branch('Cascada');
      const c = await customer(b);
      const pet = await seedPet(b, c, { name: 'Bruno' });
      const productId = randomUUID();
      await prisma.product.create({
        data: {
          id: productId,
          tenantId: b.tenantId,
          name: 'Croquetas',
          useStock: false,
        },
      });
      const sale = await prisma.sale.create({
        data: {
          tenantId: b.tenantId,
          userId: b.member.userId,
          status: 'CONFIRMED',
        },
      });
      const item = await prisma.saleItem.create({
        data: {
          tenantId: b.tenantId,
          saleId: sale.id,
          productId,
          productName: 'Croquetas',
          quantity: 1,
          unitPriceCents: 100,
          petId: pet.id,
          petNameSnapshot: 'Bruno',
          petSpeciesSnapshot: 'DOG',
        },
      });

      await prisma.customer.delete({ where: { id: c } });

      expect(await petRow(pet.id)).toBeNull();
      expect(
        await prisma.saleItem.findUnique({ where: { id: item.id } }),
      ).toMatchObject({
        petId: null,
        petNameSnapshot: 'Bruno',
        petSpeciesSnapshot: 'DOG',
      });
    });

    it('the CHECKs refuse states the API never writes', async () => {
      const b = await branch('Checks');
      const c = await customer(b);
      const bad = (over: Partial<Prisma.CustomerPetUncheckedCreateInput>) =>
        seedPet(b, c, over);

      await expect(bad({ species: 'OTHER' })).rejects.toThrow();
      await expect(bad({ speciesOther: 'Conejo' })).rejects.toThrow();
      await expect(
        bad({ birthDate: new Date('2024-01-01') }),
      ).rejects.toThrow();
      await expect(bad({ birthDatePrecision: 'EXACT' })).rejects.toThrow();
      await expect(bad({ version: 0 })).rejects.toThrow();
      expect(await petCount(c)).toBe(0);
    });
  });
});
