/**
 * shipping-zones / T1 (S3) — only recipients that can validate zones in the
 * CLS tenant receive the validation email (real PostgreSQL + real CLS).
 */
import { ClsService } from 'nestjs-cls';
import type { INestApplication } from '@nestjs/common';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  createZoneTestApp,
  disconnectWorldPrisma,
  SKIP_DB_INTEGRATION,
  worldPrisma,
  ZoneWorld,
} from '../test-support/delivery-zone-world';
import { PrismaDeliveryZoneValidatorLookup } from './prisma-delivery-zone-validator-lookup';

const describeIfDb = SKIP_DB_INTEGRATION ? describe.skip : describe;

describeIfDb('PrismaDeliveryZoneValidatorLookup (PostgreSQL)', () => {
  let app: INestApplication;
  const world = new ZoneWorld();

  beforeAll(async () => {
    app = await createZoneTestApp({
      providers: [PrismaDeliveryZoneValidatorLookup],
    });
  });

  afterEach(() => world.cleanup());

  afterAll(async () => {
    await app?.close();
    await disconnectWorldPrisma();
  });

  it('keeps validate, manage:DeliveryZone and manage:all holders of the tenant only', async () => {
    const tenantA = await world.tenant('Sucursal A');
    const tenantB = await world.tenant('Sucursal B');
    const validator = await world.member(tenantA, 'Valida', [
      'DeliveryZone:validate',
    ]);
    const manager = await world.member(tenantA, 'Gerente', [
      'DeliveryZone:manage',
    ]);
    const admin = await world.member(tenantA, 'Admin', ['all:manage']);
    const reader = await world.member(tenantA, 'Lector', ['DeliveryZone:read']);
    const inactive = await world.member(tenantA, 'Inactivo', [
      'DeliveryZone:validate',
    ]);
    await worldPrisma().user.update({
      where: { id: inactive.userId },
      data: { isActive: false },
    });
    const foreign = await world.member(tenantB, 'Otra sucursal', [
      'DeliveryZone:validate',
    ]);

    const cls = app.get(ClsService);
    const lookup = app.get(PrismaDeliveryZoneValidatorLookup);
    const result = await cls.run(async () => {
      cls.set('tenantId', tenantA);
      cls.set('isSuperAdmin', false);
      return lookup.filterValidators(
        [validator, manager, admin, reader, inactive, foreign].map(
          (member) => member.userId,
        ),
      );
    });
    expect(new Set(result)).toEqual(
      new Set([validator.userId, manager.userId, admin.userId]),
    );
    expect(app.get(TenantPrismaService)).toBeDefined();
  });
});
