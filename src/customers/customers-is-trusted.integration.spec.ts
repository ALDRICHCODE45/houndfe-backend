/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- supertest bodies are untyped JSON */
/**
 * customers-listing T4 (S3, contract §6, §6.1, §11) — `isTrusted` editable
 * through `PATCH /customers/:id` against REAL PostgreSQL, the real
 * JWT → tenant → CASL chain and the production validation pipe:
 *
 * - round-trip: PATCH → PATCH response, `GET /customers/:id`, the
 *   `GET /customers/listing` row and the stored column;
 * - only a JSON boolean (`"true"`, `1`, `null` → 400), absent = unchanged;
 * - the other PATCH fields behave as before and keep `isTrusted`;
 * - `GET /customers` items keep their exact previous keys (no `isTrusted`);
 * - `update:Customer` required; foreign/unknown → `404 ENTITY_NOT_FOUND`;
 * - `POST /customers` rejects `isTrusted` and creates with `false`;
 * - a repository save that never touched `isTrusted` (the chatbot upsert
 *   path) does not overwrite it.
 */
import type { INestApplication } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
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
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { CUSTOMER_REPOSITORY } from './domain/customer.repository';
import { PrismaCustomerRepository } from './infrastructure/prisma-customer.repository';
import { CustomersListingController } from './listing/customers-listing.controller';
import { CustomersListingService } from './listing/customers-listing.service';
import { PrismaCustomersListingReader } from './listing/prisma-customers-listing.reader';

const describeIfDb = SKIP_DB_INTEGRATION ? describe.skip : describe;

/** `GET /customers` item keys, in order, as before T4. */
const LEGACY_LIST_KEYS = [
  'id',
  'firstName',
  'lastName',
  'phoneCountryCode',
  'phone',
  'email',
  'globalPriceListId',
  'comments',
  'preferredPaymentMethod',
  'businessName',
  'fiscalZipCode',
  'rfc',
  'fiscalRegime',
  'billingStreet',
  'billingExteriorNumber',
  'billingInteriorNumber',
  'billingZipCode',
  'billingNeighborhood',
  'billingMunicipality',
  'billingCity',
  'billingState',
  'createdAt',
  'updatedAt',
  'globalPriceList',
  'addresses',
  'matchedPetName',
];

describeIfDb('PATCH /customers/:id isTrusted (PostgreSQL)', () => {
  const prisma = worldPrisma();
  const world = new ZoneWorld();
  let app: INestApplication;
  const server = () => app.getHttpServer() as App;
  const config = { get: () => undefined };

  beforeAll(async () => {
    app = await createZoneTestApp({
      controllers: [CustomersListingController, CustomersController],
      providers: [
        CustomersService,
        { provide: CUSTOMER_REPOSITORY, useClass: PrismaCustomerRepository },
        {
          provide: CustomersListingService,
          inject: [TenantPrismaService],
          useFactory: (tenantPrisma: TenantPrismaService) =>
            new CustomersListingService(
              new PrismaCustomersListingReader(tenantPrisma),
              config as unknown as ConfigService,
            ),
        },
      ],
    });
  });

  afterEach(() => world.cleanup());

  afterAll(async () => {
    await app?.close();
    await disconnectWorldPrisma();
  });

  interface Branch {
    tenantId: string;
    editor: SeededMember;
    reader: SeededMember;
  }

  async function branch(name: string): Promise<Branch> {
    const tenantId = await world.tenant(name);
    const editor = await world.member(tenantId, `Gerente ${name}`, [
      'Customer:read',
      'Customer:create',
      'Customer:update',
    ]);
    const reader = await world.member(tenantId, `Vendedor ${name}`, [
      'Customer:read',
    ]);
    return { tenantId, editor, reader };
  }

  async function customer(
    b: Branch,
    firstName: string,
    isTrusted = false,
  ): Promise<string> {
    const id = randomUUID();
    await prisma.customer.create({
      data: { id, tenantId: b.tenantId, firstName, isTrusted },
    });
    return id;
  }

  const auth = (m: SeededMember) => ({ Authorization: `Bearer ${m.token}` });
  const patch = (m: SeededMember, id: string, body: object) =>
    request(server()).patch(`/customers/${id}`).set(auth(m)).send(body);
  const getOne = (m: SeededMember, id: string) =>
    request(server()).get(`/customers/${id}`).set(auth(m));
  const stored = async (id: string) =>
    (await prisma.customer.findUniqueOrThrow({ where: { id } })).isTrusted;
  const listingRow = async (m: SeededMember, id: string) => {
    const res = await request(server())
      .get('/customers/listing')
      .query({ limit: 100 })
      .set(auth(m))
      .expect(200);
    return (res.body.data as Array<{ id: string; isTrusted: boolean }>).find(
      (r) => r.id === id,
    );
  };

  it('round-trip: PATCH true then false shows in the PATCH response, the detail, the listing row and the column', async () => {
    const b = await branch('Confianza');
    const c = await customer(b, 'Rosa');

    for (const isTrusted of [true, false]) {
      const res = await patch(b.editor, c, { isTrusted }).expect(200);
      expect(res.body).toMatchObject({ id: c, firstName: 'Rosa', isTrusted });
      expect((await getOne(b.reader, c).expect(200)).body.isTrusted).toBe(
        isTrusted,
      );
      expect((await listingRow(b.reader, c))?.isTrusted).toBe(isTrusted);
      expect(await stored(c)).toBe(isTrusted);
    }
  });

  it.each([
    ['"true"', 'true'],
    ['1', 1],
    ['null', null],
  ])(
    'isTrusted %s → 400 per-field body, nothing written',
    async (_label, value) => {
      const b = await branch('Invalido');
      const c = await customer(b, 'Rosa', true);

      const res = await patch(b.editor, c, {
        firstName: 'Otra',
        isTrusted: value,
      }).expect(400);

      expect(res.body.statusCode).toBe(400);
      expect(res.body.message).toEqual([
        expect.objectContaining({
          property: 'isTrusted',
          constraints: { isBoolean: 'isTrusted must be a boolean value' },
        }),
      ]);
      const row = await prisma.customer.findUniqueOrThrow({ where: { id: c } });
      expect(row).toMatchObject({ firstName: 'Rosa', isTrusted: true });
    },
  );

  it('regression: other PATCH fields normalize as before and leave isTrusted unchanged', async () => {
    const b = await branch('Campos');
    const c = await customer(b, 'Rosa', true);

    const res = await patch(b.editor, c, {
      firstName: '  Eva ',
      email: 'EVA@X.TEST',
      phone: '(55) 1234-5678',
      rfc: 'abcd010101xyz',
      comments: '  nota  ',
    }).expect(200);

    expect(res.body).toMatchObject({
      firstName: 'Eva',
      email: 'eva@x.test',
      phone: '5512345678',
      rfc: 'ABCD010101XYZ',
      comments: 'nota',
      isTrusted: true,
    });
    expect(res.body).not.toHaveProperty('activePetsCount');
    expect(await stored(c)).toBe(true);
    const blank = await patch(b.editor, c, { firstName: '   ' }).expect(400);
    expect(blank.body.error).toBe('INVALID_ARGUMENT');
  });

  it('GET /customers items keep exactly their previous keys, also for a trusted customer', async () => {
    const b = await branch('Picker');
    const c = await customer(b, 'Rosa', true);
    await patch(b.editor, c, { isTrusted: true }).expect(200);

    for (const query of [{}, { search: 'rosa' }]) {
      const res = await request(server())
        .get('/customers')
        .query(query)
        .set(auth(b.reader))
        .expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(Object.keys(res.body[0])).toEqual(LEGACY_LIST_KEYS);
    }
  });

  it('needs update:Customer; foreign and unknown customers stay 404 ENTITY_NOT_FOUND', async () => {
    const b = await branch('Permisos');
    const other = await branch('Permisos B');
    const c = await customer(b, 'Rosa');
    const foreign = await customer(other, 'Ajena');

    const denied = await patch(b.reader, c, { isTrusted: true }).expect(403);
    expect(denied.body.error).toBe('INSUFFICIENT_PERMISSIONS');
    for (const id of [foreign, randomUUID()]) {
      const res = await patch(b.editor, id, { isTrusted: true }).expect(404);
      expect(res.body.error).toBe('ENTITY_NOT_FOUND');
    }
    expect(await stored(c)).toBe(false);
    expect(await stored(foreign)).toBe(false);
  });

  it('POST /customers rejects isTrusted and creates with false (echoed in the response)', async () => {
    const b = await branch('Alta');

    await request(server())
      .post('/customers')
      .set(auth(b.editor))
      .send({ firstName: 'Nueva', isTrusted: true })
      .expect(400);
    const created = await request(server())
      .post('/customers')
      .set(auth(b.editor))
      .send({ firstName: 'Nueva' })
      .expect(201);

    expect(created.body.isTrusted).toBe(false);
    expect(await stored(created.body.id)).toBe(false);
  });

  it('a save that never touched isTrusted (chatbot upsert path) keeps a concurrent PATCH value', async () => {
    const b = await branch('Bot');
    const c = await customer(b, 'Rosa');
    // SAFETY: `findById`/`save` only use these two ports; the plain client is
    // fine because the ids are unique and the tenant is passed explicitly.
    const repo = new PrismaCustomerRepository({
      getClient: () => prisma,
      getTenantId: () => b.tenantId,
    } as unknown as TenantPrismaService);

    // The bot loads the customer (isTrusted false) ...
    const loaded = (await repo.findById(c))!;
    // ... the owner flips the switch meanwhile ...
    await patch(b.editor, c, { isTrusted: true }).expect(200);
    // ... and the bot saves its own change.
    loaded.preferredPaymentMethod = 'transferencia';
    await repo.save(loaded);

    const row = await prisma.customer.findUniqueOrThrow({ where: { id: c } });
    expect(row).toMatchObject({
      preferredPaymentMethod: 'transferencia',
      isTrusted: true,
    });
  });
});
