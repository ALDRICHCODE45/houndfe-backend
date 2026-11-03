/* eslint-disable @typescript-eslint/require-await -- Async Prisma mock boundary. */
import {
  Prisma,
  type ProcurementPurchaseOrder,
  type ProcurementPurchaseOrderLine,
} from '@prisma/client';
import type { ClsService } from 'nestjs-cls';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { PurchaseOrderCommands } from './po-commands';
import {
  purchaseOrderErrorEnvelope,
  type OrderInput,
  type PurchaseOrder,
} from './po-contract';

const tenantId = 'tenant-proof';
const actorId = 'actor-proof';
const id = '10000000-0000-4000-8000-000000000001';
const supplierId = '20000000-0000-4000-8000-000000000001';
const productId = '30000000-0000-4000-8000-000000000001';
const variantId = '40000000-0000-4000-8000-000000000001';
const lineId = '50000000-0000-4000-8000-000000000001';
const otherId = '60000000-0000-4000-8000-000000000001';
const time = new Date('2026-01-02T03:04:05Z');
const empty: OrderInput = {
  supplierId: null,
  note: null,
  location: { detail: null },
  lines: [],
};
const selected: OrderInput = {
  ...empty,
  supplierId,
  lines: [
    {
      lineId,
      productId,
      variantId: null,
      orderedQuantity: '2',
      informedUnitCost: {
        amount: '1.2500',
        currency: 'MXN',
        unit: 'CAJA',
        taxBasis: 'EXCLUDES_TAX',
      },
    },
  ],
};
type Header = ProcurementPurchaseOrder;
type Line = ProcurementPurchaseOrderLine;
type Audit = Record<string, unknown> & {
  afterSnapshot: PurchaseOrder;
  beforeSnapshot: PurchaseOrder;
};
type Receipt = Record<string, unknown> & {
  requestHash: string;
  responseBody: PurchaseOrder;
  statusCode: number;
};
type RootWhere = { tenantId: string; id: string; version: number };
type LineWhere = { tenantId: string; orderId: string };

function harness() {
  let rows: Header[] = [];
  let lines: Line[] = [];
  let audits: Audit[] = [];
  let receipts: Receipt[] = [];
  const events: string[] = [];
  const flags = {
    active: true,
    tenantActive: true,
    gate: true,
    ambient: false,
    casLost: false,
    failAudit: false,
    failReceipt: false,
  };
  const context: Record<string, unknown> = { tenantId, userId: actorId };
  let permissions = [
    ...['create', 'read', 'update', 'delete'].map((action) => ({
      action,
      subject: 'ProcurementPurchaseOrder',
    })),
    { action: 'read', subject: 'ProcurementSupplier' },
    { action: 'read', subject: 'Product' },
  ];
  const suppliers = [
    { id: supplierId, tenantId, displayName: 'Supplier', status: 'ACTIVE' },
  ];
  const products = [
    {
      id: productId,
      tenantId,
      name: 'Boxes',
      type: 'PRODUCT',
      unit: 'CAJA',
      hasVariants: false,
      useStock: false,
    },
  ];
  const variants = [{ id: variantId, tenantId, productId, name: 'Blue' }];
  const tx = {
    $executeRaw: jest.fn(async () => {
      events.push('lifecycle');
      return 0;
    }),
    $queryRaw: jest.fn(async (sql: Prisma.Sql) => {
      const text = sql.sql;
      if (text.includes('FROM "tenants"')) {
        events.push('tenant');
        return [
          { id: sql.values[0], name: 'Branch', isActive: flags.tenantActive },
        ];
      }
      if (text.includes('FROM "users"')) {
        events.push('user');
        return flags.active ? [{ id: sql.values[0], isActive: true }] : [];
      }
      if (text.includes('FROM "tenant_memberships"')) {
        events.push('permissions');
        return permissions;
      }
      if (text.includes('pg_try_advisory_xact_lock')) {
        events.push('gate');
        return [{ acquired: flags.gate }];
      }
      if (text.includes('FROM "procurement_purchase_orders"')) {
        events.push('order');
        return rows.filter(
          (r) => r.tenantId === sql.values[0] && r.id === sql.values[1],
        );
      }
      if (text.includes('FROM "procurement_suppliers"')) {
        events.push('supplier');
        return suppliers.filter(
          (r) => r.tenantId === sql.values[0] && sql.values.includes(r.id),
        );
      }
      if (text.includes('FROM "products"')) {
        events.push('products');
        return products.filter(
          (r) => r.tenantId === sql.values[0] && sql.values.includes(r.id),
        );
      }
      if (text.includes('FROM "variants"')) {
        events.push('variants');
        return variants.filter(
          (r) => r.tenantId === sql.values[0] && sql.values.includes(r.id),
        );
      }
      throw new Error('Unexpected SQL');
    }),
    procurementPurchaseOrder: {
      create: jest.fn(
        async ({
          data,
        }: {
          data: Omit<Header, 'id' | 'status' | 'createdAt' | 'updatedAt'>;
        }) => {
          const row: Header = {
            id,
            status: 'DRAFT',
            createdAt: time,
            updatedAt: time,
            ...data,
            supplierDisplaySnapshot:
              data.supplierDisplaySnapshot instanceof Prisma.NullTypes.DbNull
                ? null
                : data.supplierDisplaySnapshot,
          };
          rows.push(row);
          return row;
        },
      ),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: RootWhere;
          data: Omit<Partial<Header>, 'version'> & {
            version: { increment: number };
          };
        }) => {
          const row = rows.find(
            (r) =>
              r.id === where.id &&
              r.tenantId === where.tenantId &&
              r.version === where.version,
          );
          if (!row || flags.casLost) return { count: 0 };
          Object.assign(row, {
            ...data,
            version: row.version + 1,
            supplierDisplaySnapshot:
              data.supplierDisplaySnapshot instanceof Prisma.NullTypes.DbNull
                ? null
                : data.supplierDisplaySnapshot,
          });
          return { count: 1 };
        },
      ),
      deleteMany: jest.fn(async ({ where }: { where: RootWhere }) => {
        const old = rows.length;
        if (!flags.casLost) {
          rows = rows.filter(
            (r) =>
              !(
                r.id === where.id &&
                r.tenantId === where.tenantId &&
                r.version === where.version
              ),
          );
          lines = lines.filter((l) =>
            rows.some((r) => r.id === l.orderId && r.tenantId === l.tenantId),
          );
        }
        return { count: old - rows.length };
      }),
      findFirstOrThrow: jest.fn(async ({ where }: { where: RootWhere }) =>
        rows.find((r) => r.id === where.id && r.tenantId === where.tenantId),
      ),
    },
    procurementPurchaseOrderLine: {
      findMany: jest.fn(async ({ where }: { where: LineWhere }) =>
        lines
          .filter(
            (l) => l.tenantId === where.tenantId && l.orderId === where.orderId,
          )
          .sort((a, b) => a.position - b.position),
      ),
      deleteMany: jest.fn(async ({ where }: { where: LineWhere }) => {
        lines = lines.filter(
          (l) =>
            !(l.tenantId === where.tenantId && l.orderId === where.orderId),
        );
        return { count: 1 };
      }),
      createMany: jest.fn(async ({ data }: { data: Line[] }) => {
        lines.push(...data);
        return { count: data.length };
      }),
    },
    procurementPurchaseOrderAudit: {
      findFirstOrThrow: jest.fn(
        async ({
          where,
        }: {
          where: { tenantId: string; orderId: string; orderVersion: number };
        }) =>
          audits.find((a) =>
            Object.entries(where).every(([k, v]) => a[k] === v),
          ),
      ),
      create: jest.fn(async ({ data }: { data: Audit }) => {
        if (flags.failAudit) throw Error('driver');
        audits.push(structuredClone(data));
        return data;
      }),
    },
    procurementPurchaseOrderReceipt: {
      findFirst: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) => {
          events.push('receipt');
          return (
            receipts.find((r) =>
              Object.entries(where).every(([k, v]) => r[k] === v),
            ) ?? null
          );
        },
      ),
      create: jest.fn(async ({ data }: { data: Receipt }) => {
        if (flags.failReceipt) throw Error('driver');
        receipts.push(structuredClone(data));
        return data;
      }),
    },
  };
  const db = {
    getTenantId: () => context.tenantId,
    isInTransaction: () => flags.ambient,
    getClient: () => tx,
    runInTransaction: jest.fn(async (work: () => Promise<unknown>) => {
      const before = structuredClone({ rows, lines, audits, receipts });
      try {
        return await work();
      } catch (e) {
        ({ rows, lines, audits, receipts } = before);
        throw e;
      }
    }),
  };
  // SAFETY: fixture implements only the Prisma/CLS methods the command uses.
  const service = new PurchaseOrderCommands(
    db as unknown as TenantPrismaService,
    { get: (k: string) => context[k] } as unknown as ClsService<TenantClsStore>,
  );
  return {
    service,
    tx,
    db,
    flags,
    events,
    context,
    suppliers,
    products,
    variants,
    setPermissions: (p: typeof permissions) => {
      permissions = p;
    },
    permissions,
    state: () => ({ rows, lines, audits, receipts }),
  };
}
function writeCalls(h: ReturnType<typeof harness>) {
  return [
    h.tx.procurementPurchaseOrder.create,
    h.tx.procurementPurchaseOrder.updateMany,
    h.tx.procurementPurchaseOrder.deleteMany,
    h.tx.procurementPurchaseOrderLine.deleteMany,
    h.tx.procurementPurchaseOrderLine.createMany,
    h.tx.procurementPurchaseOrderAudit.create,
    h.tx.procurementPurchaseOrderReceipt.create,
  ].map((f) => f.mock.calls.length);
}
async function rejected(
  h: ReturnType<typeof harness>,
  work: () => Promise<unknown>,
  statusCode: number,
  error: string,
) {
  const before = structuredClone(h.state());
  const writes = writeCalls(h);
  const failure: unknown = await work().then(
    () => null,
    (e: unknown) => e,
  );
  expect(failure).toBeInstanceOf(Error);
  expect(purchaseOrderErrorEnvelope(failure)).toEqual({ statusCode, error });
  expect(h.state()).toEqual(before);
  expect(writeCalls(h)).toEqual(writes);
}
function copyOrder(): OrderInput {
  return {
    ...selected,
    location: { ...selected.location },
    lines: selected.lines.map((line) => ({
      ...line,
      informedUnitCost: line.informedUnitCost && { ...line.informedUnitCost },
    })),
  };
}
const replace = (
  h: ReturnType<typeof harness>,
  order: OrderInput,
  expectedVersion = 1,
  key = 'r',
) => h.service.replaceDraft(id, key, { expectedVersion, order });

describe('PurchaseOrderCommands', () => {
  it('creates incomplete draft and exact subtotal with atomic evidence', async () => {
    const h = harness();
    const result = await h.service.createDraft('c', selected);
    expect(result).toMatchObject({
      statusCode: 201,
      body: {
        ...selected,
        id,
        version: 1,
        status: 'DRAFT',
        supplierDisplaySnapshot: {
          id: supplierId,
          displayName: 'Supplier',
          status: 'ACTIVE',
        },
        lineDisplaySnapshots: [
          { lineId, productName: 'Boxes', variantName: null, unit: 'CAJA' },
        ],
        lineSubtotals: [
          {
            lineId,
            subtotal: {
              amount: '2.5',
              currency: 'MXN',
              taxBasis: 'EXCLUDES_TAX',
            },
          },
        ],
        locationSnapshot: { tenantId, tenantName: 'Branch', detail: null },
        validation: { issues: [] },
      },
    });
    expect(h.state().audits[0]).toMatchObject({
      operation: 'CREATE',
      orderVersion: 1,
      afterSnapshot: result.body,
    });
    expect(h.state().receipts[0]).toMatchObject({
      tenantId,
      actorId,
      target: 'collection',
      operation: 'CREATE',
      idempotencyKey: 'c',
      responseBody: result.body,
    });
    expect(h.db.runInTransaction).toHaveBeenCalledWith(
      expect.any(Function),
      'ReadCommitted',
    );
    const e = harness();
    expect(
      (await e.service.createDraft('e', empty)).body.validation.issues,
    ).toEqual([
      { path: '/lines', code: 'LINES_REQUIRED' },
      { path: '/supplierId', code: 'SUPPLIER_REQUIRED' },
    ]);
  });
  const referenceCases = [
    'supplierMissing',
    'supplierForeign',
    'archived',
    'productMissing',
    'productForeign',
    'service',
    'variantMissing',
    'variantForeign',
    'wrongParent',
    'withoutVariants',
    'unit',
    'fraction',
  ].flatMap((kind) =>
    ['create', 'replace'].map((operation) => ({ kind, operation })),
  );
  it.each(referenceCases)('rejects $operation $kind', async (c) => {
    const { kind, operation } = c;
    const h = harness();
    if (operation === 'replace') await h.service.createDraft('baseline', empty);
    const order = copyOrder();
    if (kind === 'supplierMissing') h.suppliers.length = 0;
    if (kind === 'supplierForeign') h.suppliers[0].tenantId = 'foreign';
    if (kind === 'archived') h.suppliers[0].status = 'ARCHIVED';
    if (kind === 'productMissing') h.products.length = 0;
    if (kind === 'productForeign') h.products[0].tenantId = 'foreign';
    if (kind === 'service') h.products[0].type = 'SERVICE';
    if (
      [
        'variantMissing',
        'variantForeign',
        'wrongParent',
        'withoutVariants',
      ].includes(kind)
    ) {
      order.lines[0].variantId = variantId;
      h.products[0].hasVariants = kind !== 'withoutVariants';
    }
    if (kind === 'variantMissing') h.variants.length = 0;
    if (kind === 'variantForeign') h.variants[0].tenantId = 'foreign';
    if (kind === 'wrongParent') h.variants[0].productId = otherId;
    if (kind === 'unit') order.lines[0].informedUnitCost!.unit = 'UNIDAD';
    if (kind === 'fraction') order.lines[0].orderedQuantity = '1.5';
    const missing = kind.includes('Missing') || kind.includes('Foreign');
    await rejected(
      h,
      () =>
        operation === 'create'
          ? h.service.createDraft('c', order)
          : replace(h, order),
      missing ? 404 : kind === 'archived' ? 409 : 400,
      missing
        ? 'NOT_FOUND'
        : kind === 'archived'
          ? 'SUPPLIER_ARCHIVED'
          : 'MALFORMED',
    );
  });
  it.each(['create', 'replace', 'delete'] as const)(
    'requires every individual %s permission',
    async (operation) => {
      const needed =
        operation === 'create'
          ? [
              'create:ProcurementPurchaseOrder',
              'read:ProcurementSupplier',
              'read:Product',
            ]
          : operation === 'replace'
            ? [
                'read:ProcurementPurchaseOrder',
                'update:ProcurementPurchaseOrder',
                'read:ProcurementSupplier',
                'read:Product',
              ]
            : [
                'read:ProcurementPurchaseOrder',
                'delete:ProcurementPurchaseOrder',
              ];
      for (const denied of needed) {
        const h = harness();
        await h.service.createDraft('c', selected);
        h.setPermissions(
          h.permissions.filter((p) => `${p.action}:${p.subject}` !== denied),
        );
        await rejected(
          h,
          () =>
            operation === 'create'
              ? h.service.createDraft('x', empty)
              : operation === 'replace'
                ? replace(h, empty)
                : h.service.deleteDraft(id, 'd', { expectedVersion: 1 }),
          403,
          'FORBIDDEN',
        );
        expect(h.events.at(-1)).toBe('permissions');
      }
    },
  );
  it.each([
    'missing',
    'service',
    'unit',
    'variantMissing',
    'wrongParent',
    'withoutVariants',
  ])(
    'retains invalidated %s with last labels and diagnostics',
    async (kind) => {
      const h = harness();
      const order = copyOrder();
      if (
        kind.startsWith('variant') ||
        kind === 'wrongParent' ||
        kind === 'withoutVariants'
      ) {
        h.products[0].hasVariants = true;
        order.lines[0].variantId = variantId;
      }
      const saved = await h.service.createDraft('c', order);
      h.suppliers[0].status = 'ARCHIVED';
      if (kind === 'missing') h.products.length = 0;
      if (kind === 'service') h.products[0].type = 'SERVICE';
      if (kind === 'unit') h.products[0].unit = 'UNIDAD';
      if (kind === 'variantMissing') h.variants.length = 0;
      if (kind === 'wrongParent') h.variants[0].productId = otherId;
      if (kind === 'withoutVariants') h.products[0].hasVariants = false;
      order.note = 'edited';
      order.lines[0].orderedQuantity = '3';
      order.lines[0].informedUnitCost!.amount = '2';
      const result = await replace(h, order);
      expect(result.body.version).toBe(2);
      expect(result.body.validation.issues).toContainEqual({
        path: '/supplierId',
        code: 'SUPPLIER_ARCHIVED',
      });
      expect(result.body.lineDisplaySnapshots).toEqual(
        saved.body.lineDisplaySnapshots,
      );
      expect(result.body.lineSubtotals[0].subtotal).toBeNull();
      expect(h.state().audits[1].beforeSnapshot).toEqual(saved.body);
    },
  );
  it('refreshes valid labels; retains archived supplier but rejects re-selection', async () => {
    const h = harness();
    await h.service.createDraft('c', selected);
    h.products[0].name = 'Renamed';
    h.suppliers[0].status = 'ARCHIVED';
    expect(
      (await replace(h, selected)).body.lineDisplaySnapshots[0].productName,
    ).toBe('Renamed');
    await replace(h, empty, 2, 'clear');
    await rejected(
      h,
      () => replace(h, selected, 3, 'select'),
      409,
      'SUPPLIER_ARCHIVED',
    );
  });
  it.each(['newLine', 'changedProduct', 'completePendingVariant', 'costUnit'])(
    'does not inherit baseline admission for %s',
    async (kind) => {
      const h = harness();
      const order = copyOrder();
      if (kind === 'completePendingVariant') h.products[0].hasVariants = true;
      await h.service.createDraft('c', order);
      if (kind === 'newLine') {
        order.lines[0].lineId = otherId;
        h.products.length = 0;
      }
      if (kind === 'changedProduct') order.lines[0].productId = otherId;
      if (kind === 'completePendingVariant') {
        order.lines[0].variantId = variantId;
        h.variants[0].productId = otherId;
      }
      if (kind === 'costUnit') {
        h.products.length = 0;
        order.lines[0].informedUnitCost!.unit = 'UNIDAD';
      }
      const missing = kind === 'newLine' || kind === 'changedProduct';
      await rejected(
        h,
        () => replace(h, order),
        missing ? 404 : 400,
        missing ? 'NOT_FOUND' : 'MALFORMED',
      );
    },
  );
  it('allows clearing invalid cost unit; decimal quantities and explicit zero', async () => {
    const h = harness();
    h.products[0].unit = 'KILOGRAMO';
    const order = copyOrder();
    order.lines[0].orderedQuantity = '1.125';
    order.lines[0].informedUnitCost!.unit = 'KILOGRAMO';
    order.lines[0].informedUnitCost!.amount = '0';
    const created = await h.service.createDraft('c', order);
    expect(created.body.lineSubtotals[0].subtotal?.amount).toBe('0');
    h.products.length = 0;
    order.lines[0].informedUnitCost!.unit = null;
    expect((await replace(h, order)).body.validation.issues).toContainEqual({
      path: '/lines/0/productId',
      code: 'REFERENCE_UNAVAILABLE',
    });
  });
  it.each(['stale', 'ceiling', 'missing', 'foreign'])(
    'rejects %s before references/writes',
    async (kind) => {
      const h = harness();
      await h.service.createDraft('c', selected);
      if (kind === 'ceiling') h.state().rows[0].version = 2147483647;
      if (kind === 'missing') h.state().rows.length = 0;
      if (kind === 'foreign') h.state().rows[0].tenantId = 'foreign';
      h.events.length = 0;
      const missing = kind === 'missing' || kind === 'foreign';
      await rejected(
        h,
        () => replace(h, selected, kind === 'ceiling' ? 2147483647 : 2),
        missing ? 404 : 409,
        missing ? 'NOT_FOUND' : 'ORDER_VERSION_CONFLICT',
      );
      expect(h.events).not.toContain('supplier');
    },
  );
  it('replaces all lines; deletes header/lines with retained audit and historical replays', async () => {
    const h = harness();
    const created = await h.service.createDraft('c', selected);
    const order = {
      ...empty,
      lines: [{ ...selected.lines[0], lineId: otherId }],
    };
    const replaced = await replace(h, order);
    expect(h.state().lines.map((l) => l.lineId)).toEqual([otherId]);
    expect(
      await h.service.deleteDraft(id, 'd', { expectedVersion: 2 }),
    ).toEqual({ statusCode: 204, body: null });
    expect(h.state().rows).toEqual([]);
    expect(h.state().lines).toEqual([]);
    expect(h.state().audits[2]).toMatchObject({
      operation: 'DELETE',
      orderVersion: 3,
      beforeSnapshot: replaced.body,
    });
    expect(
      await h.service.deleteDraft(id, 'd', { expectedVersion: 2 }),
    ).toEqual({ statusCode: 204, body: null });
    expect(await h.service.createDraft('c', selected)).toEqual(created);
    expect(await replace(h, order)).toEqual(replaced);
    await rejected(
      h,
      () => h.service.deleteDraft(id, 'd', { expectedVersion: 3 }),
      409,
      'IDEMPOTENCY_KEY_CONFLICT',
    );
  });
  it.each(['active', 'tenantActive', 'permissions'])(
    'checks revoked %s before replay',
    async (kind) => {
      const h = harness();
      await h.service.createDraft('c', selected);
      h.events.length = 0;
      if (kind === 'permissions') h.setPermissions([]);
      else h.flags[kind as 'active' | 'tenantActive'] = false;
      await rejected(
        h,
        () => h.service.createDraft('c', selected),
        kind === 'active' ? 401 : 403,
        kind === 'active' ? 'UNAUTHORIZED' : 'FORBIDDEN',
      );
      expect(h.events).not.toContain('receipt');
    },
  );
  it('uses manage:all; gate before receipt and full namespace', async () => {
    const h = harness();
    h.setPermissions([{ action: 'manage', subject: 'all' }]);
    await h.service.createDraft(' key ', empty);
    expect(h.events).toEqual([
      'lifecycle',
      'tenant',
      'user',
      'permissions',
      'gate',
      'receipt',
    ]);
    expect(h.tx.procurementPurchaseOrderReceipt.findFirst).toHaveBeenCalledWith(
      {
        where: {
          tenantId,
          actorId,
          operation: 'CREATE',
          target: 'collection',
          idempotencyKey: ' key ',
        },
      },
    );
    h.flags.gate = false;
    await rejected(
      h,
      () => h.service.createDraft('new', empty),
      409,
      'IDEMPOTENCY_KEY_IN_FLIGHT',
    );
  });
  it.each(['failAudit', 'failReceipt'] as const)(
    'rolls all writes back on %s for all operations',
    async (flag) => {
      for (const operation of ['create', 'replace', 'delete']) {
        const h = harness();
        if (operation !== 'create') await h.service.createDraft('c', selected);
        const before = structuredClone(h.state());
        h.flags[flag] = true;
        await expect(
          operation === 'create'
            ? h.service.createDraft('c', selected)
            : operation === 'replace'
              ? replace(h, empty)
              : h.service.deleteDraft(id, 'd', { expectedVersion: 1 }),
        ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
        expect(h.state()).toEqual(before);
      }
    },
  );
  it.each(['replace', 'delete'])(
    'does not emit evidence on a lost conditional %s count',
    async (operation) => {
      const h = harness();
      await h.service.createDraft('c', selected);
      const before = structuredClone(h.state());
      h.flags.casLost = true;
      const failure: unknown = await (
        operation === 'replace'
          ? replace(h, empty)
          : h.service.deleteDraft(id, 'd', { expectedVersion: 1 })
      ).catch((error: unknown) => error);
      expect(purchaseOrderErrorEnvelope(failure)).toEqual({
        statusCode: 409,
        error: 'ORDER_VERSION_CONFLICT',
      });
      expect(h.state()).toEqual(before);
      expect(h.tx.procurementPurchaseOrderAudit.create).toHaveBeenCalledTimes(
        1,
      );
      expect(h.tx.procurementPurchaseOrderReceipt.create).toHaveBeenCalledTimes(
        1,
      );
    },
  );
  it('retains fractional quantity after unit change, and permits explicit compatible unit correction', async () => {
    const h = harness();
    h.products[0].unit = 'KILOGRAMO';
    const order = copyOrder();
    order.lines[0].orderedQuantity = '1.5';
    order.lines[0].informedUnitCost!.unit = 'KILOGRAMO';
    await h.service.createDraft('c', order);
    h.products[0].unit = 'UNIDAD';
    const retained = await replace(h, order);
    expect(retained.body.validation.issues).toContainEqual({
      path: '/lines/0/orderedQuantity',
      code: 'QUANTITY_FRACTION_NOT_ALLOWED',
    });
    order.lines[0].orderedQuantity = '2';
    order.lines[0].informedUnitCost!.unit = 'UNIDAD';
    const corrected = await replace(h, order, 2, 'correction');
    expect(corrected.body.validation.issues).toEqual([]);
    expect(corrected.body.lineDisplaySnapshots[0].unit).toBe('UNIDAD');
  });
  it('rejects a changed fractional quantity on a retained line with a valid integer unit', async () => {
    const h = harness();
    h.products[0].unit = 'CAJA';
    const order = copyOrder();
    order.lines[0].orderedQuantity = '2';
    order.lines[0].informedUnitCost!.unit = 'CAJA';
    await h.service.createDraft('c', order);
    order.lines[0].orderedQuantity = '1.5';
    await rejected(h, () => replace(h, order), 400, 'MALFORMED');
  });
  it('rejects changing a drift-retained fraction to another fraction', async () => {
    const h = harness();
    h.products[0].unit = 'KILOGRAMO';
    const order = copyOrder();
    order.lines[0].orderedQuantity = '1.5';
    order.lines[0].informedUnitCost!.unit = 'KILOGRAMO';
    await h.service.createDraft('c', order);
    h.products[0].unit = 'UNIDAD';
    order.lines[0].orderedQuantity = '2.5';
    await rejected(h, () => replace(h, order), 400, 'MALFORMED');
  });
  it('validates retained syntax, identity and ambient transaction before work', async () => {
    const h = harness();
    await h.service.createDraft('c', selected);
    const bad = copyOrder();
    bad.lines[0].orderedQuantity = '0';
    await rejected(h, () => replace(h, bad), 400, 'MALFORMED');
    h.context.userId = null;
    await rejected(
      h,
      () => h.service.createDraft('x', empty),
      401,
      'UNAUTHORIZED',
    );
    h.context.userId = actorId;
    h.context.tenantId = null;
    await rejected(
      h,
      () => h.service.createDraft('x', empty),
      403,
      'FORBIDDEN',
    );
    h.context.tenantId = tenantId;
    h.flags.ambient = true;
    await rejected(
      h,
      () => h.service.createDraft('x', empty),
      500,
      'INTERNAL_ERROR',
    );
  });
});
