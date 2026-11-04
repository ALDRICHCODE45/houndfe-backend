import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { normalizeTestDatabaseUrl } from '../../../test/integration/setup/test-database-url';
import { PurchaseOrderQueries } from './po-queries';
import { PurchaseOrderCursor } from './po-cursor';

// AUTHORED ONLY. Parent must use the guarded integration config after verifying
// a newly disposable database. No execution/SQL proof is claimed here.
// Random owned fixtures remain in that database; no cleanup deletion.
const describeDb =
  process.env.SKIP_DB_INTEGRATION === '1' ? describe.skip : describe;

describeDb('PO PostgreSQL query boundary', () => {
  let db: PrismaClient;
  beforeAll(() => {
    normalizeTestDatabaseUrl(process.env.DATABASE_URL, '[po-queries]');
    db = new PrismaClient();
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  async function fixture() {
    const tenantId = randomUUID();
    const otherTenantId = randomUUID();
    const actorId = randomUUID();
    const roleId = randomUUID();
    for (const id of [tenantId, otherTenantId])
      await db.tenant.create({ data: { id, name: 'Owned PO read', slug: id } });
    await db.user.create({
      data: {
        id: actorId,
        email: `${actorId}@po-read.invalid`,
        name: 'Owned reader',
        hashedPassword: 'not-a-login-hash',
      },
    });
    await db.role.create({
      data: { id: roleId, tenantId, name: randomUUID() },
    });
    const permission = await db.permission.upsert({
      where: {
        subject_action: { subject: 'ProcurementPurchaseOrder', action: 'read' },
      },
      create: { subject: 'ProcurementPurchaseOrder', action: 'read' },
      update: {},
    });
    await db.rolePermission.create({
      data: { roleId, permissionId: permission.id },
    });
    await db.tenantMembership.create({
      data: { tenantId, userId: actorId, roleId },
    });
    const supplier = await db.procurementSupplier.create({
      data: { tenantId, displayName: 'Owned supplier', status: 'ACTIVE' },
    });
    const product = await db.product.create({
      data: {
        tenantId,
        name: 'Owned product',
        type: 'PRODUCT',
        unit: 'KILOGRAMO',
        useStock: false,
      },
    });
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort().reverse();
    const time = new Date('2026-01-02T03:04:05.123Z');
    for (const [index, id] of ids.entries()) {
      await db.procurementPurchaseOrder.create({
        data: {
          id,
          tenantId,
          supplierId: index === 2 ? null : supplier.id,
          locationTenantName: 'Saved tenant',
          supplierDisplaySnapshot:
            index === 2
              ? undefined
              : {
                  id: supplier.id,
                  displayName: 'Saved supplier',
                  status: 'ACTIVE',
                },
          createdAt: time,
        },
      });
      await db.procurementPurchaseOrderLine.create({
        data: {
          tenantId,
          orderId: id,
          lineId: randomUUID(),
          position: 0,
          productId: product.id,
          orderedQuantity: '2.5',
          informedUnitCostPresent: true,
          costAmount: '4',
          currency: 'MXN',
          costUnit: 'KILOGRAMO',
          taxBasis: 'EXCLUDES_TAX',
          productName: 'Saved product',
          unitSnapshot: 'KILOGRAMO',
        },
      });
    }
    const foreign = await db.procurementPurchaseOrder.create({
      data: { tenantId: otherTenantId, locationTenantName: 'Foreign' },
    });
    const cls = new ClsService<TenantClsStore>(new AsyncLocalStorage());
    const tenantDb = new TenantPrismaService(db as PrismaService, cls);
    const service = new PurchaseOrderQueries(
      tenantDb,
      cls,
      new PurchaseOrderCursor('owned-proof-only'),
    );
    const run = <T>(work: () => T): T =>
      cls.runWith({ tenantId, userId: actorId, isSuperAdmin: false }, work);
    return {
      tenantId,
      actorId,
      roleId,
      ids,
      supplier,
      product,
      foreign,
      service,
      run,
    };
  }

  async function evidence(tenantId: string) {
    const where = { tenantId };
    return Promise.all([
      db.procurementPurchaseOrder.findMany({ where, orderBy: { id: 'asc' } }),
      db.procurementPurchaseOrderLine.findMany({
        where,
        orderBy: { orderId: 'asc' },
      }),
      db.procurementPurchaseOrderAudit.count({ where }),
      db.procurementPurchaseOrderReceipt.count({ where }),
      db.product.findMany({ where }),
      db.sale.count({ where }),
      db.salePayment.count({ where }),
      db.outboxEvent.count({ where }),
    ]);
  }

  it('paginates timestamp ties, filters supplier and performs no business/evidence writes', async () => {
    const f = await fixture();
    const before = await evidence(f.tenantId);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let index = 0; index < 3; index++) {
      const page = await f.run(() =>
        f.service.listDrafts({ limit: '1', ...(cursor ? { cursor } : {}) }),
      );
      expect(page.items).toHaveLength(1);
      seen.push(page.items[0].id);
      const detail = await f.run(() => f.service.getDraft(page.items[0].id));
      expect(page.items[0].issueCount).toBe(detail.validation.issues.length);
      expect(detail.lineSubtotals[0].subtotal?.amount).toBe('10');
      cursor = page.nextCursor ?? undefined;
    }
    expect(cursor).toBeUndefined();
    expect(seen).toEqual(f.ids);
    const filtered = await f.run(() =>
      f.service.listDrafts({ supplierId: f.supplier.id, limit: '1' }),
    );
    expect(filtered.items.map((item) => item.id)).toEqual([f.ids[0]]);
    await expect(
      f.run(() => f.service.listDrafts({ cursor: filtered.nextCursor })),
    ).rejects.toMatchObject({ code: 'MALFORMED' });
    await expect(
      f.run(() => f.service.getDraft(f.foreign.id)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await evidence(f.tenantId)).toEqual(before);
  });

  it('searches CURRENT supplier OR note literally, including supplierless drafts, ANDs supplierId and binds pagination', async () => {
    const f = await fixture();
    const term = 'É_%\\';
    await db.procurementSupplier.update({
      where: { id: f.supplier.id },
      data: { displayName: `Renamed ${term}` },
    });
    await db.procurementPurchaseOrder.update({
      where: { id: f.ids[0] },
      data: { note: 'OnlyNote' },
    });
    await db.procurementPurchaseOrder.update({
      where: { id: f.ids[2] },
      data: { note: `Supplierless ${term}` },
    });
    await db.procurementPurchaseOrder.update({
      where: { id: f.foreign.id },
      data: { note: term },
    });
    await db.procurementPurchaseOrder.create({
      data: {
        tenantId: f.tenantId,
        locationTenantName: 'Owned decoy',
        note: 'Plain wildcard decoy',
      },
    });
    const list = (search: string, supplierId?: string) =>
      f.run(() =>
        f.service.listDrafts({ search, ...(supplierId ? { supplierId } : {}) }),
      );
    for (const search of ['  é_%\\  ', '%', '_', '\\'])
      expect((await list(search)).items.map((item) => item.id)).toEqual(f.ids);
    expect((await list('OnlyNote')).items.map((item) => item.id)).toEqual([
      f.ids[0],
    ]);
    expect(
      (await list(term, f.supplier.id)).items.map((item) => item.id),
    ).toEqual(f.ids.slice(0, 2));
    expect((await list('Saved supplier')).items).toEqual([]);
    expect((await list("' OR 1=1 --")).items).toEqual([]);
    const first = await f.run(() =>
      f.service.listDrafts({ search: ` ${term} `, limit: '1' }),
    );
    const second = await f.run(() =>
      f.service.listDrafts({
        search: term,
        limit: '2',
        cursor: first.nextCursor,
      }),
    );
    expect(first.items.map((item) => item.id)).toEqual([f.ids[0]]);
    expect(second.items.map((item) => item.id)).toEqual(f.ids.slice(1));
    expect(second.nextCursor).toBeNull();
    for (const search of [undefined, 'other', term.toLowerCase()])
      await expect(
        f.run(() =>
          f.service.listDrafts({
            ...(search ? { search } : {}),
            cursor: first.nextCursor,
          }),
        ),
      ).rejects.toMatchObject({ code: 'MALFORMED' });
  });

  it('recomputes diagnostics after catalog/supplier drift without changing stored draft', async () => {
    const f = await fixture();
    await db.product.update({
      where: { id: f.product.id },
      data: { type: 'SERVICE' },
    });
    await db.procurementSupplier.update({
      where: { id: f.supplier.id },
      data: { status: 'ARCHIVED' },
    });
    const before = await evidence(f.tenantId);
    const detail = await f.run(() => f.service.getDraft(f.ids[0]));
    expect(detail.validation.issues).toEqual([
      { path: '/lines/0/productId', code: 'REFERENCE_INCOMPATIBLE' },
      { path: '/supplierId', code: 'SUPPLIER_ARCHIVED' },
    ]);
    expect(detail.lineDisplaySnapshots[0].productName).toBe('Saved product');
    expect(detail.lineSubtotals[0].subtotal).toBeNull();
    expect(detail.supplierCurrentVersion).toBe(f.supplier.version);
    expect(detail.referenceToken).toBeNull();
    expect(detail.canConfirm).toBe(false);
    const page = await f.run(() => f.service.listDrafts({}));
    expect(page.items[0].issueCount).toBe(2);
    expect(await evidence(f.tenantId)).toEqual(before);
  });

  it('checks persisted authority before missing/foreign detail even after prior successful read', async () => {
    const f = await fixture();
    await f.run(() => f.service.getDraft(f.ids[0]));
    const denied = await db.role.create({
      data: { tenantId: f.tenantId, name: randomUUID() },
    });
    const membership = await db.tenantMembership.findFirstOrThrow({
      where: { tenantId: f.tenantId, userId: f.actorId },
    });
    await db.tenantMembership.update({
      where: { id: membership.id },
      data: { roleId: denied.id },
    });
    await expect(
      f.run(() => f.service.getDraft(f.foreign.id)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.run(() => f.service.listDrafts({}))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
