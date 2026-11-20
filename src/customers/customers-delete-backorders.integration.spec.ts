/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest bodies are untyped JSON */
/**
 * restock-backorder / T1b (S1 §1, owner decision L5) — `DELETE /customers/:id`
 * against REAL PostgreSQL with the real JWT → tenant → CASL guard chain.
 *
 * Rule: a customer with a WAITING or RESERVED backorder cannot be deleted
 * (409 CUSTOMER_HAS_ACTIVE_BACKORDERS, nothing is deleted); with only
 * CONFIRMED/EXPIRED/CANCELLED ones the customer is deleted together with them;
 * a customer without backorders behaves exactly as before (204, empty body).
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
const DAY = 86_400_000;

describeIfDb('DELETE /customers/:id with backorders (PostgreSQL)', () => {
  const prisma = worldPrisma();
  const world = new ZoneWorld();
  let app: INestApplication;
  const server = () => app.getHttpServer() as App;

  interface Tenant {
    tenantId: string;
    member: SeededMember;
    productId: string;
    decisionId: string;
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

  async function tenant(name: string): Promise<Tenant> {
    const tenantId = await world.tenant(name);
    const member = await world.member(tenantId, `Gerente ${name}`, [
      'Customer:read',
      'Customer:delete',
    ]);
    const productId = randomUUID();
    await prisma.product.create({
      data: { id: productId, tenantId, name: 'Croquetas', useStock: true },
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
    return { tenantId, member, productId, decisionId: decision.id };
  }

  async function customer(t: Tenant, firstName = 'Rosa'): Promise<string> {
    const id = randomUUID();
    await prisma.customer.create({
      data: { id, tenantId: t.tenantId, firstName },
    });
    return id;
  }

  let folio = 0;
  async function backorder(
    t: Tenant,
    customerId: string,
    over: Partial<Prisma.BackorderUncheckedCreateInput> = {},
  ) {
    folio += 1;
    return prisma.backorder.create({
      data: {
        tenantId: t.tenantId,
        folio: `BO-${String(Date.now() % 1_000_000).padStart(6, '0')}${folio}`,
        customerId,
        productId: t.productId,
        quantity: 1,
        referencePriceCents: 1000,
        scheduledAt: new Date(),
        estimatedArrivalDays: 7,
        estimatedAt: new Date(Date.now() + 7 * DAY),
        sourceDecisionId: t.decisionId,
        idempotencyKey: randomUUID(),
        requestHash: 'a'.repeat(64),
        ...over,
      },
    });
  }

  const cancelled = () => ({
    status: 'CANCELLED' as const,
    cancelledAt: new Date(),
    cancelledByKind: 'CUSTOMER' as const,
  });
  const expired = () => ({
    status: 'EXPIRED' as const,
    expiredAt: new Date(),
  });
  const reserved = () => ({
    status: 'RESERVED' as const,
    reservedAt: new Date(),
    reservedUntil: new Date(Date.now() + DAY),
    reminderAt: new Date(Date.now() + DAY - 3_600_000),
    currentPriceCents: 900,
    finalPriceCents: 900,
  });

  const del = (member: SeededMember, id: string) =>
    request(server())
      .delete(`/customers/${id}`)
      .set('Authorization', `Bearer ${member.token}`);

  const customerExists = async (id: string) =>
    (await prisma.customer.count({ where: { id } })) === 1;
  const backorderCount = (customerId: string) =>
    prisma.backorder.count({ where: { customerId } });

  it('customer without backorders: 204, empty body, customer gone (unchanged behaviour)', async () => {
    const t = await tenant('Sin pedidos');
    const id = await customer(t);

    const res = await del(t.member, id).expect(204);

    expect(res.body).toEqual({});
    expect(res.text).toBe('');
    expect(await customerExists(id)).toBe(false);
  });

  it('customer without backorders: unknown id is still 404 ENTITY_NOT_FOUND', async () => {
    const t = await tenant('Sin pedidos 404');
    const res = await del(t.member, randomUUID()).expect(404);
    expect(res.body.error).toBe('ENTITY_NOT_FOUND');
  });

  it('WAITING backorder: 409 CUSTOMER_HAS_ACTIVE_BACKORDERS and nothing is deleted', async () => {
    const t = await tenant('Espera');
    const id = await customer(t);
    await backorder(t, id, cancelled());
    await backorder(t, id);

    const res = await del(t.member, id).expect(409);

    expect(res.body).toEqual({
      statusCode: 409,
      error: 'CUSTOMER_HAS_ACTIVE_BACKORDERS',
      message: 'El cliente tiene pedidos por reposición activos',
      timestamp: expect.any(String) as string,
    });
    expect(await customerExists(id)).toBe(true);
    expect(await backorderCount(id)).toBe(2);
  });

  it('RESERVED backorder: 409 and nothing is deleted', async () => {
    const t = await tenant('Apartado');
    const id = await customer(t);
    await backorder(t, id, expired());
    await backorder(t, id, reserved());

    await del(t.member, id).expect(409);

    expect(await customerExists(id)).toBe(true);
    expect(await backorderCount(id)).toBe(2);
  });

  it('only CANCELLED / EXPIRED / CONFIRMED backorders: customer and those backorders are deleted', async () => {
    const t = await tenant('Terminales');
    const id = await customer(t);
    const sale = await prisma.sale.create({
      data: { tenantId: t.tenantId, userId: t.member.userId },
    });
    await backorder(t, id, cancelled());
    await backorder(t, id, expired());
    await backorder(t, id, {
      status: 'CONFIRMED',
      confirmedAt: new Date(),
      saleId: sale.id,
      currentPriceCents: 900,
      finalPriceCents: 900,
    });
    expect(await backorderCount(id)).toBe(3);

    await del(t.member, id).expect(204);

    expect(await customerExists(id)).toBe(false);
    expect(await backorderCount(id)).toBe(0);
    // The confirmed backorder's sale survives (its customer link is set null).
    expect(await prisma.sale.count({ where: { id: sale.id } })).toBe(1);
  });

  it('another tenant is untouched; foreign customers cannot be deleted through this tenant', async () => {
    const a = await tenant('Tenant A');
    const b = await tenant('Tenant B');
    const customerA = await customer(a);
    const customerB = await customer(b);
    await backorder(a, customerA, cancelled());
    await backorder(b, customerB, cancelled());
    await backorder(b, customerB);

    await del(a.member, customerA).expect(204);
    expect(await backorderCount(customerA)).toBe(0);
    expect(await customerExists(customerB)).toBe(true);
    expect(await backorderCount(customerB)).toBe(2);

    // Tenant A cannot see (404) nor delete tenant B's customer.
    await del(a.member, customerB).expect(404);
    expect(await customerExists(customerB)).toBe(true);
    expect(await backorderCount(customerB)).toBe(2);
  });

  it('a customer with only terminal backorders next to an active one of ANOTHER customer is deleted', async () => {
    const t = await tenant('Dos clientes');
    const rosa = await customer(t, 'Rosa');
    const luis = await customer(t, 'Luis');
    await backorder(t, rosa, cancelled());
    await backorder(t, luis);

    await del(t.member, rosa).expect(204);

    expect(await customerExists(rosa)).toBe(false);
    expect(await customerExists(luis)).toBe(true);
    expect(await backorderCount(luis)).toBe(1);
  });
});
