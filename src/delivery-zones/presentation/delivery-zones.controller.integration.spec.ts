/**
 * shipping-zones / T1 (S1) — store delivery-zone routes against REAL
 * PostgreSQL, the REAL JWT -> CLS tenant -> CASL guard chain and real grants.
 */
import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types';
import request from 'supertest';
import { DELIVERY_ZONE_REPOSITORY } from '../domain/delivery-zone.repository';
import { PrismaDeliveryZoneRepository } from '../infrastructure/prisma-delivery-zone.repository';
import {
  createZoneTestApp,
  disconnectWorldPrisma,
  SKIP_DB_INTEGRATION,
  worldPrisma,
  ZoneWorld,
  type SeededMember,
} from '../test-support/delivery-zone-world';
import { DeliveryZonesController } from './delivery-zones.controller';

const describeIfDb = SKIP_DB_INTEGRATION ? describe.skip : describe;

describeIfDb('DeliveryZonesController (PostgreSQL)', () => {
  let app: INestApplication;
  const server = () => app.getHttpServer() as App;
  const world = new ZoneWorld();
  let tenantA: string;
  let tenantB: string;
  let managerA: SeededMember;
  let readerA: SeededMember;
  let outsiderA: SeededMember;
  let managerB: SeededMember;

  beforeAll(async () => {
    app = await createZoneTestApp({
      controllers: [DeliveryZonesController],
      providers: [
        {
          provide: DELIVERY_ZONE_REPOSITORY,
          useClass: PrismaDeliveryZoneRepository,
        },
      ],
    });
  });

  beforeEach(async () => {
    tenantA = await world.tenant('Sucursal A');
    tenantB = await world.tenant('Sucursal B');
    managerA = await world.member(tenantA, 'Gerente A', [
      'DeliveryZone:read',
      'DeliveryZone:manage',
    ]);
    readerA = await world.member(tenantA, 'Lector A', ['DeliveryZone:read']);
    outsiderA = await world.member(tenantA, 'Sin permiso A', ['Sale:read']);
    managerB = await world.member(tenantB, 'Gerente B', [
      'DeliveryZone:read',
      'DeliveryZone:manage',
    ]);
  });

  afterEach(() => world.cleanup());

  afterAll(async () => {
    await app?.close();
    await disconnectWorldPrisma();
  });

  const put = (member: SeededMember, zip: string, body: object) =>
    request(server())
      .put(`/delivery-zones/${zip}`)
      .set('Authorization', `Bearer ${member.token}`)
      .send(body);

  it('creates a SURCHARGE zone with the approver snapshot and reads it back', async () => {
    const created = await put(managerA, '06700', {
      type: 'SURCHARGE',
      surchargeCents: 4500,
      etaDays: 2,
      state: 'Ciudad de México',
      municipality: 'Cuauhtémoc',
      neighborhood: 'Roma Norte',
    }).expect(200);
    expect(created.body).toMatchObject({
      zipCode: '06700',
      type: 'SURCHARGE',
      surchargeCents: 4500,
      etaDays: 2,
      isActive: true,
      approvedBy: { id: managerA.userId, displayName: 'Gerente A' },
      sourceValidationId: null,
    });

    const read = await request(server())
      .get('/delivery-zones/06700')
      .set('Authorization', `Bearer ${readerA.token}`)
      .expect(200);
    expect(read.body).toEqual(created.body);

    const list = await request(server())
      .get('/delivery-zones?search=roma')
      .set('Authorization', `Bearer ${readerA.token}`)
      .expect(200);
    const listBody = list.body as {
      data: Array<{ zipCode: string }>;
      pagination: unknown;
    };
    expect(listBody.pagination).toEqual({
      pageIndex: 0,
      pageSize: 20,
      totalCount: 1,
      pageCount: 1,
    });
    expect(listBody.data[0].zipCode).toBe('06700');
  });

  it('rejects an inconsistent zone shape with 400 INVALID_DELIVERY_ZONE', async () => {
    const res = await put(managerA, '06700', {
      type: 'FREE',
      surchargeCents: 100,
      etaDays: 1,
    }).expect(400);
    expect((res.body as { code: string }).code).toBe('INVALID_DELIVERY_ZONE');
    await put(managerA, '06700', { type: 'CARRIER_ONLY', etaDays: 3 }).expect(
      400,
    );
    await put(managerA, '6700', { type: 'DENIED' }).expect(400);
    expect(
      await worldPrisma().deliveryZone.count({ where: { tenantId: tenantA } }),
    ).toBe(0);
  });

  it('deactivates a zone softly and keeps it readable', async () => {
    await put(managerA, '06700', { type: 'CARRIER_ONLY' }).expect(200);
    const res = await request(server())
      .delete('/delivery-zones/06700')
      .set('Authorization', `Bearer ${managerA.token}`)
      .expect(200);
    expect(res.body).toMatchObject({ zipCode: '06700', isActive: false });
    const active = await request(server())
      .get('/delivery-zones?active=true')
      .set('Authorization', `Bearer ${readerA.token}`)
      .expect(200);
    expect((active.body as { data: unknown[] }).data).toEqual([]);
  });

  it('answers 403 without the permission and 401 without a token', async () => {
    await request(server())
      .get('/delivery-zones')
      .set('Authorization', `Bearer ${outsiderA.token}`)
      .expect(403);
    await put(readerA, '06700', { type: 'DENIED' }).expect(403);
    await request(server()).get('/delivery-zones').expect(401);
  });

  it('isolates tenants: another tenant zone is invisible (404) and untouchable', async () => {
    await put(managerB, '06700', { type: 'FREE', etaDays: 1 }).expect(200);
    await request(server())
      .get('/delivery-zones/06700')
      .set('Authorization', `Bearer ${readerA.token}`)
      .expect(404);
    const del = await request(server())
      .delete('/delivery-zones/06700')
      .set('Authorization', `Bearer ${managerA.token}`)
      .expect(404);
    expect((del.body as { code: string }).code).toBe('DELIVERY_ZONE_NOT_FOUND');
    const zoneB = await worldPrisma().deliveryZone.findFirstOrThrow({
      where: { tenantId: tenantB, zipCode: '06700' },
    });
    expect(zoneB.isActive).toBe(true);
  });

  it('refuses a manual edit while a validation is pending (409)', async () => {
    await worldPrisma().deliveryZoneValidation.create({
      data: {
        tenantId: tenantA,
        zipCode: '06700',
        state: 'CDMX',
        municipality: 'Cuauhtémoc',
        neighborhood: 'Roma Norte',
      },
    });
    const res = await put(managerA, '06700', { type: 'DENIED' }).expect(409);
    expect((res.body as { code: string }).code).toBe(
      'DELIVERY_ZONE_VALIDATION_PENDING',
    );
  });
});
