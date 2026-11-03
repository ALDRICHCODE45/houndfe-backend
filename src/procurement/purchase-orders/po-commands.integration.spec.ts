import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { normalizeTestDatabaseUrl } from '../../../test/integration/setup/test-database-url';
import { PurchaseOrderCommands } from './po-commands';
import { SupplierCommands } from '../suppliers/supplier-commands';
import type { OrderInput } from './po-contract';

// Parent only: guarded integration config AND verified NEW disposable ownership.
// Never execute against an existing/shared DB. Owned fixtures are left in place.
const describeDb =
  process.env.SKIP_DB_INTEGRATION === '1' ? describe.skip : describe;
const empty: OrderInput = {
  supplierId: null,
  note: null,
  location: { detail: null },
  lines: [],
};

describeDb('purchase-order command PostgreSQL protocol', () => {
  let db: PrismaClient;
  beforeAll(() => {
    normalizeTestDatabaseUrl(process.env.DATABASE_URL, '[po-commands]');
    db = new PrismaClient();
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  async function fixture() {
    const tenantId = randomUUID();
    const actorId = randomUUID();
    const roleId = randomUUID();
    await db.$transaction(async (tx) => {
      await tx.tenant.create({
        data: { id: tenantId, name: 'PO SQL proof', slug: tenantId },
      });
      await tx.user.create({
        data: {
          id: actorId,
          email: `${actorId}@po.invalid`,
          name: 'Owned proof actor',
          hashedPassword: 'not-a-login-hash',
        },
      });
      await tx.role.create({
        data: { id: roleId, tenantId, name: `Owned PO ${roleId}` },
      });
      for (const subject of [
        'ProcurementPurchaseOrder',
        'ProcurementSupplier',
        'Product',
      ]) {
        for (const action of ['create', 'read', 'update', 'delete']) {
          const permission = await tx.permission.upsert({
            where: { subject_action: { subject, action } },
            create: { subject, action },
            update: {},
          });
          await tx.rolePermission.create({
            data: { roleId, permissionId: permission.id },
          });
        }
      }
      await tx.tenantMembership.create({
        data: { tenantId, userId: actorId, roleId },
      });
    });
    const cls = new ClsService<TenantClsStore>(new AsyncLocalStorage());
    // SAFETY: service uses Prisma API, not Nest lifecycle/configuration hooks.
    const tenantDb = new TenantPrismaService(db as PrismaService, cls);
    const commands = new PurchaseOrderCommands(tenantDb, cls);
    const suppliers = new SupplierCommands(tenantDb, cls);
    const run = <T>(work: () => T): T =>
      cls.runWith({ tenantId, userId: actorId, isSuperAdmin: false }, work);
    const supplier = await run(() =>
      suppliers.create('supplier', {
        displayName: 'Owned supplier',
        termsText: null,
        status: 'ACTIVE',
      }),
    );
    const product = await db.product.create({
      data: {
        tenantId,
        name: 'Owned boxes',
        type: 'PRODUCT',
        unit: 'CAJA',
        useStock: false,
      },
    });
    const order: OrderInput = {
      ...empty,
      supplierId: supplier.body.id,
      lines: [
        {
          lineId: randomUUID(),
          productId: product.id,
          variantId: null,
          orderedQuantity: '2',
          informedUnitCost: {
            amount: '1.2500',
            currency: 'MXN',
            unit: 'CAJA',
            taxBasis: 'INCLUDES_TAX',
          },
        },
      ],
    };
    return {
      tenantId,
      actorId,
      roleId,
      tenantDb,
      commands,
      suppliers,
      supplierId: supplier.body.id,
      order,
      run,
    };
  }

  async function evidence(tenantId: string) {
    const where = { tenantId };
    return Promise.all([
      db.procurementPurchaseOrder.findMany({ where }),
      db.procurementPurchaseOrderLine.findMany({ where }),
      db.procurementPurchaseOrderAudit.findMany({ where }),
      db.procurementPurchaseOrderReceipt.findMany({ where }),
      db.sale.count({ where }),
      db.salePayment.count({ where }),
      db.outboxEvent.count({ where }),
      db.product.findMany({ where }),
    ]);
  }

  it('persists wire/replay; deletion cascades lines but retains evidence', async () => {
    const f = await fixture();
    const before = await evidence(f.tenantId);
    const created = await f.run(() => f.commands.createDraft('c', f.order));
    const id = created.body.id;
    const edit = { expectedVersion: 1, order: { ...f.order, note: 'edited' } };
    const replaced = await f.run(() => f.commands.replaceDraft(id, 'r', edit));
    expect(replaced.body.version).toBe(2);
    expect(replaced.body.lineSubtotals[0].subtotal?.amount).toBe('2.5');
    const deleted = await f.run(() =>
      f.commands.deleteDraft(id, 'd', { expectedVersion: 2 }),
    );
    expect(deleted).toEqual({ statusCode: 204, body: null });
    const where = { tenantId: f.tenantId };
    expect(await db.procurementPurchaseOrder.count({ where })).toBe(0);
    expect(await db.procurementPurchaseOrderLine.count({ where })).toBe(0);
    const audits = await db.procurementPurchaseOrderAudit.findMany({
      where: { ...where, orderId: id },
      orderBy: { orderVersion: 'asc' },
    });
    expect(audits).toHaveLength(3);
    expect(audits[0]).toMatchObject({
      beforeSnapshot: null,
      afterSnapshot: created.body,
    });
    expect(audits[1]).toMatchObject({
      beforeSnapshot: created.body,
      afterSnapshot: replaced.body,
    });
    expect(audits[2]).toMatchObject({
      operation: 'DELETE',
      orderVersion: 3,
      beforeSnapshot: replaced.body,
      afterSnapshot: null,
    });
    expect(await f.run(() => f.commands.createDraft('c', f.order))).toEqual(
      created,
    );
    expect(await f.run(() => f.commands.replaceDraft(id, 'r', edit))).toEqual(
      replaced,
    );
    const replay = await f.run(() =>
      f.commands.deleteDraft(id, 'd', { expectedVersion: 2 }),
    );
    expect(replay).toEqual({ statusCode: 204, body: null });
    const receipts = await db.procurementPurchaseOrderReceipt.findMany({
      where: { ...where, orderId: id },
    });
    expect(receipts).toHaveLength(3);
    expect(receipts.find((r) => r.operation === 'DELETE')).toMatchObject({
      statusCode: 204,
      responseBody: null,
    });
    const after = await evidence(f.tenantId);
    expect(after.slice(4)).toEqual(before.slice(4));
  });

  it('serializes two-key CAS: exactly one replacement applies', async () => {
    const f = await fixture();
    const created = await f.run(() => f.commands.createDraft('c', f.order));
    const outcomes = await Promise.allSettled(
      ['a', 'b'].map((key) =>
        f.run(() =>
          f.commands.replaceDraft(created.body.id, key, {
            expectedVersion: 1,
            order: { ...f.order, note: key },
          }),
        ),
      ),
    );
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((r) => r.status === 'rejected');
    expect(rejected).toMatchObject({
      reason: { code: 'ORDER_VERSION_CONFLICT' },
    });
    const where = { tenantId: f.tenantId };
    expect(await db.procurementPurchaseOrderAudit.count({ where })).toBe(2);
    expect(await db.procurementPurchaseOrderReceipt.count({ where })).toBe(2);
  });

  it('returns IN_FLIGHT while gate is held, then permits manual recovery', async () => {
    const f = await fixture();
    const gate = createHash('sha256')
      .update(
        JSON.stringify([
          'procurement-purchase-order-command-v1',
          f.tenantId,
          f.actorId,
          'CREATE',
          'collection',
          'held',
        ]),
      )
      .digest()
      .readBigInt64BE(0);
    const before = await evidence(f.tenantId);
    await db.$transaction(async (tx) => {
      // pg_advisory_xact_lock returns void, which $queryRaw cannot decode.
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(${gate}::bigint)`,
      );
      await expect(
        f.run(() => f.commands.createDraft('held', empty)),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_IN_FLIGHT' });
    });
    expect(await evidence(f.tenantId)).toEqual(before);
    const recovered = await f.run(() => f.commands.createDraft('held', empty));
    expect(recovered.statusCode).toBe(201);
  });

  it('checks current persisted authority before replay disclosure', async () => {
    const f = await fixture();
    await f.run(() => f.commands.createDraft('c', empty));
    const permission = await db.permission.findUniqueOrThrow({
      where: { subject_action: { subject: 'Product', action: 'read' } },
    });
    await db.rolePermission.deleteMany({
      where: { roleId: f.roleId, permissionId: permission.id },
    });
    const before = await evidence(f.tenantId);
    await expect(
      f.run(() => f.commands.createDraft('c', empty)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await evidence(f.tenantId)).toEqual(before);
  });

  it('restricts supplier delete after CAS; direct FK also blocks; discard releases restriction', async () => {
    const f = await fixture();
    const created = await f.run(() => f.commands.createDraft('c', f.order));
    await expect(
      f.run(() =>
        f.suppliers.delete(f.supplierId, 'stale', { expectedVersion: 2 }),
      ),
    ).rejects.toMatchObject({ code: 'SUPPLIER_VERSION_CONFLICT' });
    const before = await evidence(f.tenantId);
    await expect(
      f.run(() =>
        f.suppliers.delete(f.supplierId, 'blocked', { expectedVersion: 1 }),
      ),
    ).rejects.toMatchObject({ code: 'SUPPLIER_HAS_PURCHASE_ORDERS' });
    await expect(
      db.procurementSupplier.deleteMany({
        where: { tenantId: f.tenantId, id: f.supplierId },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    expect(await evidence(f.tenantId)).toEqual(before);
    await f.run(() =>
      f.commands.deleteDraft(created.body.id, 'd', { expectedVersion: 1 }),
    );
    const deleted = await f.run(() =>
      f.suppliers.delete(f.supplierId, 'delete', { expectedVersion: 1 }),
    );
    expect(deleted).toEqual({ statusCode: 204, body: null });
    const replay = await f.run(() =>
      f.suppliers.delete(f.supplierId, 'delete', { expectedVersion: 1 }),
    );
    expect(replay).toEqual({ statusCode: 204, body: null });
  });

  it('serializes concurrent supplier deletion and new draft selection', async () => {
    const f = await fixture();
    const outcomes = await Promise.allSettled([
      f.run(() => f.commands.createDraft('c', f.order)),
      f.run(() =>
        f.suppliers.delete(f.supplierId, 'd', { expectedVersion: 1 }),
      ),
    ]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    if (outcomes[0].status === 'fulfilled') {
      expect(outcomes[1]).toMatchObject({
        reason: { code: 'SUPPLIER_HAS_PURCHASE_ORDERS' },
      });
    } else {
      expect(outcomes[0]).toMatchObject({ reason: { code: 'NOT_FOUND' } });
    }
  });

  it.each([
    'procurementPurchaseOrderAudit',
    'procurementPurchaseOrderReceipt',
  ] as const)(
    'rolls real writes back when %s fails after mutation',
    async (delegate) => {
      const f = await fixture();
      const created = await f.run(() => f.commands.createDraft('c', f.order));
      const before = await evidence(f.tenantId);
      const original: unknown = Reflect.get(f.tenantDb, 'getClient');
      if (typeof original !== 'function')
        throw new Error('Missing client method');
      let reached = false;
      // Preserve Prisma proxy receivers; only selected delegate is wrapped.
      const spy = jest.spyOn(f.tenantDb, 'getClient').mockImplementation(() => {
        // SAFETY: invoke the saved service method with its original receiver.
        const client = Reflect.apply(original, f.tenantDb, []) as object;
        const proxy = new Proxy(client, {
          get(target, property) {
            const value: unknown = Reflect.get(target, property, target);
            if (property === delegate && value && typeof value === 'object') {
              return new Proxy(value, {
                get(model, method) {
                  if (method === 'create')
                    return () => {
                      reached = true;
                      throw new Error('injected evidence failure');
                    };
                  const fn: unknown = Reflect.get(model, method, model);
                  return typeof fn === 'function'
                    ? (fn.bind(model) as unknown)
                    : fn;
                },
              });
            }
            return typeof value === 'function'
              ? (value.bind(target) as unknown)
              : value;
          },
        });
        // SAFETY: proxy changes only the selected create method; all other
        // properties retain the original client/delegate receivers.
        return proxy as ReturnType<TenantPrismaService['getClient']>;
      });
      try {
        await expect(
          f.run(() =>
            f.commands.replaceDraft(created.body.id, 'r', {
              expectedVersion: 1,
              order: empty,
            }),
          ),
        ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
      } finally {
        spy.mockRestore();
      }
      expect(reached).toBe(true);
      expect(await evidence(f.tenantId)).toEqual(before);
    },
  );
});
