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
    tenantName: 'Branch',
  };
  const sqls: string[] = [];
  const context: Record<string, unknown> = { tenantId, userId: actorId };
  let permissions = [
    ...['create', 'read', 'update', 'delete'].map((action) => ({
      action,
      subject: 'ProcurementPurchaseOrder',
    })),
    { action: 'read', subject: 'ProcurementSupplier' },
    { action: 'read', subject: 'Product' },
    { action: 'create', subject: 'ProcurementOrderConfirmation' },
    { action: 'create', subject: 'ProcurementOrderCancellation' },
  ];
  const suppliers = [
    {
      id: supplierId,
      tenantId,
      displayName: 'Supplier',
      status: 'ACTIVE',
      version: 3,
    },
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
      sqls.push(text);
      if (text.includes('FROM "tenants"')) {
        events.push('tenant');
        return [
          {
            id: sql.values[0],
            name: flags.tenantName,
            isActive: flags.tenantActive,
          },
        ];
      }
      if (text.includes('FROM "users"')) {
        events.push('user');
        return flags.active
          ? [{ id: sql.values[0], isActive: true, name: 'Ana Compradora' }]
          : [];
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
          data: Omit<
            Header,
            | 'id'
            | 'status'
            | 'createdAt'
            | 'updatedAt'
            | 'confirmedAt'
            | 'confirmedByDisplayName'
            | 'cancelledAt'
            | 'cancelledByDisplayName'
            | 'lineSubtotalsSnapshot'
          >;
        }) => {
          const row: Header = {
            id,
            status: 'DRAFT',
            confirmedAt: null,
            confirmedByDisplayName: null,
            cancelledAt: null,
            cancelledByDisplayName: null,
            lineSubtotalsSnapshot: null,
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
          });
          if ('supplierDisplaySnapshot' in data)
            row.supplierDisplaySnapshot =
              data.supplierDisplaySnapshot instanceof Prisma.NullTypes.DbNull
                ? null
                : (data.supplierDisplaySnapshot ?? null);
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
    sqls,
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
        supplierCurrentVersion: 3,
        referenceToken: expect.stringMatching(/^prt1\.[\w-]{43}$/) as unknown,
        canConfirm: true,
        confirmedAt: null,
        confirmedBy: null,
        cancelledAt: null,
        cancelledBy: null,
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
  it('PUT returns the same extended shape: token stable across quantity/cost edits, live supplier version, canConfirm false for an archived retained supplier', async () => {
    const h = harness();
    const created = await h.service.createDraft('c', selected);
    const edited = copyOrder();
    edited.lines[0].orderedQuantity = '9';
    edited.lines[0].informedUnitCost!.amount = '77';
    const replaced = await replace(h, edited);
    expect(Object.keys(replaced.body).sort()).toEqual(
      Object.keys(created.body).sort(),
    );
    expect(replaced.body.referenceToken).toBe(created.body.referenceToken);
    expect(replaced.body).toMatchObject({
      supplierCurrentVersion: 3,
      canConfirm: true,
    });
    h.suppliers[0].status = 'ARCHIVED';
    h.suppliers[0].version = 5;
    const archived = await replace(h, edited, 2, 'r2');
    expect(archived.body).toMatchObject({
      supplierCurrentVersion: 5,
      canConfirm: false,
      validation: { issues: [{ code: 'SUPPLIER_ARCHIVED' }] },
    });
    expect(archived.body.referenceToken).not.toBeNull();
    const incomplete = await h.service.createDraft('i', empty);
    expect(incomplete.body).toMatchObject({
      supplierCurrentVersion: null,
      referenceToken: null,
      canConfirm: false,
    });
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

type Harness = ReturnType<typeof harness>;
/** The conditional update is attempted but nothing else is written. */
async function lostCas(h: Harness, work: () => Promise<unknown>) {
  const before = structuredClone(h.state());
  const audits = h.tx.procurementPurchaseOrderAudit.create.mock.calls.length;
  const receipts =
    h.tx.procurementPurchaseOrderReceipt.create.mock.calls.length;
  const failure: unknown = await work().then(
    () => null,
    (error: unknown) => error,
  );
  expect(purchaseOrderErrorEnvelope(failure)).toEqual({
    statusCode: 409,
    error: 'ORDER_VERSION_CONFLICT',
  });
  expect(h.state()).toEqual(before);
  expect(h.tx.procurementPurchaseOrderAudit.create.mock.calls).toHaveLength(
    audits,
  );
  expect(h.tx.procurementPurchaseOrderReceipt.create.mock.calls).toHaveLength(
    receipts,
  );
}
const confirmBodyOf = (order: PurchaseOrder) => ({
  expectedVersion: order.version,
  expectedSupplierVersion: order.supplierCurrentVersion,
  expectedReferenceToken: order.referenceToken,
});
const confirm = (
  h: Harness,
  body: ReturnType<typeof confirmBodyOf>,
  key = 'k',
) => h.service.confirm(id, key, body);
const cancel = (h: Harness, expectedVersion: number, key = 'x') =>
  h.service.cancel(id, key, { expectedVersion });

describe('PurchaseOrderCommands confirm (S4)', () => {
  it('locks order -> supplier -> products -> variants, refreshes snapshots, freezes subtotals and writes audit + receipt atomically', async () => {
    const h = harness();
    h.products[0].hasVariants = true;
    const withVariant = copyOrder();
    withVariant.lines[0].variantId = variantId;
    const created = await h.service.createDraft('c', withVariant);
    h.suppliers[0].displayName = 'Supplier Renamed';
    h.products[0].name = 'Boxes v2';
    h.variants[0].name = 'Red';
    h.flags.tenantName = 'Branch 2';
    h.events.length = 0;
    const before = Date.now();
    const result = await confirm(h, confirmBodyOf(created.body));
    expect(h.events).toEqual([
      'lifecycle',
      'tenant',
      'user',
      'permissions',
      'gate',
      'receipt',
      'order',
      'supplier',
      'products',
      'variants',
    ]);
    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({
      id,
      version: 2,
      status: 'CONFIRMED',
      supplierCurrentVersion: 3,
      supplierDisplaySnapshot: {
        id: supplierId,
        displayName: 'Supplier Renamed',
        status: 'ACTIVE',
      },
      lineDisplaySnapshots: [
        { lineId, productName: 'Boxes v2', variantName: 'Red', unit: 'CAJA' },
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
      locationSnapshot: { tenantId, tenantName: 'Branch 2', detail: null },
      validation: { issues: [] },
      referenceToken: null,
      canConfirm: false,
      confirmedBy: { displayName: 'Ana Compradora' },
      cancelledAt: null,
      cancelledBy: null,
    });
    const confirmedAt = Date.parse(result.body.confirmedAt!);
    expect(confirmedAt).toBeGreaterThanOrEqual(before);
    expect(confirmedAt).toBeLessThanOrEqual(Date.now());
    const state = h.state();
    expect(state.rows[0]).toMatchObject({
      status: 'CONFIRMED',
      version: 2,
      confirmedByDisplayName: 'Ana Compradora',
      locationTenantName: 'Branch 2',
      lineSubtotalsSnapshot: result.body.lineSubtotals,
      supplierDisplaySnapshot: { displayName: 'Supplier Renamed' },
    });
    expect(state.lines).toMatchObject([
      {
        lineId,
        position: 0,
        productName: 'Boxes v2',
        variantName: 'Red',
        unitSnapshot: 'CAJA',
      },
    ]);
    expect(state.audits[1]).toMatchObject({
      operation: 'CONFIRM',
      orderVersion: 2,
      actorId,
      beforeSnapshot: created.body,
      afterSnapshot: result.body,
    });
    expect(state.receipts[1]).toMatchObject({
      tenantId,
      actorId,
      operation: 'CONFIRM',
      target: id,
      orderId: id,
      idempotencyKey: 'k',
      statusCode: 200,
      responseBody: result.body,
    });
    expect(h.db.runInTransaction).toHaveBeenLastCalledWith(
      expect.any(Function),
      'ReadCommitted',
    );
  });

  describe('check order, first failure wins; nothing is written', () => {
    async function drafted(h: Harness) {
      return (await h.service.createDraft('c', selected)).body;
    }
    it('1 ORDER_VERSION_CONFLICT beats a non-DRAFT order state', async () => {
      const h = harness();
      const draft = await drafted(h);
      await confirm(h, confirmBodyOf(draft));
      await rejected(
        h,
        () => confirm(h, confirmBodyOf(draft), 'again'),
        409,
        'ORDER_VERSION_CONFLICT',
      );
    });
    it('2 ORDER_STATE_CONFLICT for CONFIRMED and CANCELLED orders', async () => {
      const h = harness();
      const draft = await drafted(h);
      const confirmed = await confirm(h, confirmBodyOf(draft));
      await rejected(
        h,
        () => confirm(h, confirmBodyOf(confirmed.body), 'again'),
        409,
        'ORDER_STATE_CONFLICT',
      );
      const cancelled = await cancel(h, 2);
      await rejected(
        h,
        () => confirm(h, confirmBodyOf(cancelled.body), 'third'),
        409,
        'ORDER_STATE_CONFLICT',
      );
    });
    it('3 ORDER_NOT_READY without a supplier, before any supplier version comparison and before reference locks', async () => {
      const h = harness();
      const draft = (await h.service.createDraft('c', empty)).body;
      h.events.length = 0;
      await rejected(
        h,
        () =>
          confirm(h, {
            expectedVersion: 1,
            expectedSupplierVersion: 99,
            expectedReferenceToken: null,
          }),
        409,
        'ORDER_NOT_READY',
      );
      expect(draft.supplierCurrentVersion).toBeNull();
      expect(h.events).not.toContain('supplier');
    });
    it('4 SUPPLIER_VERSION_CONFLICT for a null or different expected version, beating archive and token checks', async () => {
      const h = harness();
      const draft = await drafted(h);
      h.suppliers[0].status = 'ARCHIVED';
      for (const expectedSupplierVersion of [null, 2]) {
        await rejected(
          h,
          () =>
            confirm(h, {
              ...confirmBodyOf(draft),
              expectedSupplierVersion,
              expectedReferenceToken: 'prt1.stale',
            }),
          409,
          'SUPPLIER_VERSION_CONFLICT',
        );
      }
      h.suppliers[0].version = 4;
      await rejected(
        h,
        () => confirm(h, confirmBodyOf(draft)),
        409,
        'SUPPLIER_VERSION_CONFLICT',
      );
    });
    it('5 SUPPLIER_ARCHIVED beats a null token and a stale token', async () => {
      const h = harness();
      const draft = await drafted(h);
      h.suppliers[0].status = 'ARCHIVED';
      h.products[0].type = 'SERVICE';
      await rejected(
        h,
        () => confirm(h, confirmBodyOf(draft)),
        409,
        'SUPPLIER_ARCHIVED',
      );
    });
    it('6 ORDER_NOT_READY when the recomputed token is null, even with a null or stale expected token (never null === null)', async () => {
      const h = harness();
      const draft = await drafted(h);
      h.products[0].type = 'SERVICE';
      for (const expectedReferenceToken of [
        draft.referenceToken,
        null,
        'prt1.stale',
      ])
        await rejected(
          h,
          () => confirm(h, { ...confirmBodyOf(draft), expectedReferenceToken }),
          409,
          'ORDER_NOT_READY',
        );
      const emptyLines = (
        await h.service.createDraft('e', { ...selected, lines: [] })
      ).body;
      expect(emptyLines.referenceToken).toBeNull();
      await rejected(
        h,
        () =>
          h.service.confirm(emptyLines.id, 'n', {
            expectedVersion: emptyLines.version,
            expectedSupplierVersion: emptyLines.supplierCurrentVersion,
            expectedReferenceToken: null,
          }),
        409,
        'ORDER_NOT_READY',
      );
    });
    it('7 ELIGIBILITY_CHANGED for a null or different expected token when the current token is valid', async () => {
      const h = harness();
      const draft = await drafted(h);
      for (const expectedReferenceToken of [null, 'prt1.stale'])
        await rejected(
          h,
          () => confirm(h, { ...confirmBodyOf(draft), expectedReferenceToken }),
          409,
          'ELIGIBILITY_CHANGED',
        );
    });
    it.each(['cost', 'quantity', 'fraction'])(
      '8 ORDER_NOT_READY for remaining %s issues with a valid matching token',
      async (kind) => {
        const h = harness();
        const order = copyOrder();
        if (kind === 'cost') order.lines[0].informedUnitCost!.amount = null;
        if (kind === 'quantity') order.lines[0].orderedQuantity = null;
        if (kind === 'fraction') {
          h.products[0].unit = 'KILOGRAMO';
          order.lines[0].orderedQuantity = '1.5';
          order.lines[0].informedUnitCost!.unit = null;
        }
        let draft = (await h.service.createDraft('c', order)).body;
        if (kind === 'fraction') {
          // The unit later became integer-only; the retained fraction is
          // an issue, not a reference blocker, and the token follows the unit.
          h.products[0].unit = 'CAJA';
          draft = (await replace(h, order)).body;
          expect(draft.validation.issues).toContainEqual({
            path: '/lines/0/orderedQuantity',
            code: 'QUANTITY_FRACTION_NOT_ALLOWED',
          });
        }
        expect(draft.referenceToken).not.toBeNull();
        await rejected(
          h,
          () => confirm(h, confirmBodyOf(draft)),
          409,
          'ORDER_NOT_READY',
        );
      },
    );
  });

  it('replays the stored 200 first: no order/reference locks, no re-execution, body conflict, authority revalidated first', async () => {
    const h = harness();
    const created = await h.service.createDraft('c', selected);
    const body = confirmBodyOf(created.body);
    const first = await confirm(h, body);
    h.events.length = 0;
    const auditWrites =
      h.tx.procurementPurchaseOrderAudit.create.mock.calls.length;
    expect(await confirm(h, body)).toEqual(first);
    expect(h.events).toEqual([
      'lifecycle',
      'tenant',
      'user',
      'permissions',
      'gate',
      'receipt',
    ]);
    expect(h.tx.procurementPurchaseOrderAudit.create.mock.calls).toHaveLength(
      auditWrites,
    );
    h.suppliers[0].status = 'ARCHIVED';
    h.suppliers[0].version = 9;
    expect(await confirm(h, body)).toEqual(first);
    await rejected(
      h,
      () => confirm(h, { ...body, expectedSupplierVersion: 4 }),
      409,
      'IDEMPOTENCY_KEY_CONFLICT',
    );
    await cancel(h, 2);
    expect(await confirm(h, body)).toEqual(first);
    h.events.length = 0;
    h.setPermissions([]);
    await rejected(h, () => confirm(h, body), 403, 'FORBIDDEN');
    expect(h.events).not.toContain('receipt');
  });
  it('returns IN_FLIGHT when the gate is held', async () => {
    const h = harness();
    const created = await h.service.createDraft('c', selected);
    h.flags.gate = false;
    await rejected(
      h,
      () => confirm(h, confirmBodyOf(created.body)),
      409,
      'IDEMPOTENCY_KEY_IN_FLIGHT',
    );
  });
  it('requires create:ProcurementOrderConfirmation and read:ProcurementPurchaseOrder, nothing else', async () => {
    for (const denied of [
      'create:ProcurementOrderConfirmation',
      'read:ProcurementPurchaseOrder',
    ]) {
      const h = harness();
      const created = await h.service.createDraft('c', selected);
      h.setPermissions(
        h.permissions.filter((p) => `${p.action}:${p.subject}` !== denied),
      );
      await rejected(
        h,
        () => confirm(h, confirmBodyOf(created.body)),
        403,
        'FORBIDDEN',
      );
      expect(h.events.at(-1)).toBe('permissions');
    }
    const h = harness();
    const created = await h.service.createDraft('c', selected);
    h.setPermissions([
      { action: 'read', subject: 'ProcurementPurchaseOrder' },
      { action: 'create', subject: 'ProcurementOrderConfirmation' },
    ]);
    expect((await confirm(h, confirmBodyOf(created.body))).body.status).toBe(
      'CONFIRMED',
    );
    const cancelOnly = harness();
    const draft = await cancelOnly.service.createDraft('c', selected);
    cancelOnly.setPermissions([
      { action: 'read', subject: 'ProcurementPurchaseOrder' },
      { action: 'create', subject: 'ProcurementOrderCancellation' },
      { action: 'update', subject: 'ProcurementPurchaseOrder' },
    ]);
    await rejected(
      cancelOnly,
      () => confirm(cancelOnly, confirmBodyOf(draft.body)),
      403,
      'FORBIDDEN',
    );
  });
  it('rejects malformed bodies and unknown orders before any lock', async () => {
    const h = harness();
    const created = await h.service.createDraft('c', selected);
    const bad = { ...confirmBodyOf(created.body), extra: 1 };
    await rejected(h, () => h.service.confirm(id, 'k', bad), 400, 'MALFORMED');
    await rejected(
      h,
      () => h.service.confirm(id, 'k', { expectedVersion: 1 }),
      400,
      'MALFORMED',
    );
    await rejected(
      h,
      () => h.service.confirm('not-an-id', 'k', confirmBodyOf(created.body)),
      400,
      'MALFORMED',
    );
    await rejected(
      h,
      () => h.service.confirm(otherId, 'k', confirmBodyOf(created.body)),
      404,
      'NOT_FOUND',
    );
  });
  it.each(['failAudit', 'failReceipt'] as const)(
    'rolls the whole confirm back on %s',
    async (flag) => {
      const h = harness();
      const created = await h.service.createDraft('c', selected);
      const before = structuredClone(h.state());
      h.flags[flag] = true;
      await expect(
        confirm(h, confirmBodyOf(created.body)),
      ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
      expect(h.state()).toEqual(before);
    },
  );
  it('does not emit evidence on a lost conditional update', async () => {
    const h = harness();
    const created = await h.service.createDraft('c', selected);
    h.flags.casLost = true;
    await lostCas(h, () => confirm(h, confirmBodyOf(created.body)));
  });
});

describe('PurchaseOrderCommands cancel (S5)', () => {
  it('cancels a DRAFT under the order lock only, with no reference validation and no frozen subtotals', async () => {
    const h = harness();
    const created = await h.service.createDraft('c', selected);
    h.suppliers[0].status = 'ARCHIVED';
    h.suppliers[0].version = 8;
    h.products.length = 0;
    h.events.length = 0;
    h.sqls.length = 0;
    const result = await cancel(h, 1);
    expect(h.events).toEqual([
      'lifecycle',
      'tenant',
      'user',
      'permissions',
      'gate',
      'receipt',
      'order',
      'supplier',
    ]);
    // The only reference read is the lock-free supplier version for the response.
    const supplierRead = h.sqls.find((sql) =>
      sql.includes('FROM "procurement_suppliers"'),
    );
    expect(supplierRead).not.toMatch(/FOR (UPDATE|SHARE|NO KEY)/);
    expect(h.sqls.filter((sql) => /products|variants/.test(sql))).toEqual([]);
    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({
      id,
      version: 2,
      status: 'CANCELLED',
      supplierCurrentVersion: 8,
      confirmedAt: null,
      confirmedBy: null,
      cancelledBy: { displayName: 'Ana Compradora' },
      validation: { issues: [] },
      referenceToken: null,
      canConfirm: false,
      lineSubtotals: [{ lineId, subtotal: null }],
      supplierDisplaySnapshot: created.body.supplierDisplaySnapshot,
      lineDisplaySnapshots: created.body.lineDisplaySnapshots,
    });
    expect(typeof result.body.cancelledAt).toBe('string');
    expect(h.state().rows[0]).toMatchObject({
      status: 'CANCELLED',
      version: 2,
      confirmedAt: null,
      confirmedByDisplayName: null,
      cancelledByDisplayName: 'Ana Compradora',
      lineSubtotalsSnapshot: null,
    });
    expect(h.state().audits[1]).toMatchObject({
      operation: 'CANCEL',
      orderVersion: 2,
      beforeSnapshot: created.body,
      afterSnapshot: result.body,
    });
    expect(h.state().receipts[1]).toMatchObject({
      operation: 'CANCEL',
      target: id,
      orderId: id,
      idempotencyKey: 'x',
      statusCode: 200,
      responseBody: result.body,
    });
  });
  it('cancels a CONFIRMED order keeping confirmed columns and frozen snapshots untouched', async () => {
    const h = harness();
    const created = await h.service.createDraft('c', selected);
    const confirmed = await confirm(h, confirmBodyOf(created.body));
    const frozen = structuredClone(h.state());
    h.suppliers[0].displayName = 'Renamed later';
    h.flags.tenantName = 'Renamed branch';
    const result = await cancel(h, 2);
    expect(result.body).toMatchObject({
      version: 3,
      status: 'CANCELLED',
      confirmedAt: confirmed.body.confirmedAt,
      confirmedBy: { displayName: 'Ana Compradora' },
      cancelledBy: { displayName: 'Ana Compradora' },
      supplierDisplaySnapshot: confirmed.body.supplierDisplaySnapshot,
      lineDisplaySnapshots: confirmed.body.lineDisplaySnapshots,
      lineSubtotals: confirmed.body.lineSubtotals,
      locationSnapshot: confirmed.body.locationSnapshot,
    });
    expect(h.state().rows[0]).toMatchObject({
      confirmedAt: frozen.rows[0].confirmedAt,
      lineSubtotalsSnapshot: frozen.rows[0].lineSubtotalsSnapshot,
      supplierDisplaySnapshot: frozen.rows[0].supplierDisplaySnapshot,
      locationTenantName: frozen.rows[0].locationTenantName,
    });
    expect(h.state().lines).toEqual(frozen.lines);
    expect(h.state().audits[2]).toMatchObject({
      operation: 'CANCEL',
      orderVersion: 3,
      beforeSnapshot: confirmed.body,
      afterSnapshot: result.body,
    });
  });
  it('ORDER_VERSION_CONFLICT first, then ORDER_STATE_CONFLICT for CANCELLED', async () => {
    const h = harness();
    await h.service.createDraft('c', selected);
    await rejected(h, () => cancel(h, 7), 409, 'ORDER_VERSION_CONFLICT');
    await cancel(h, 1);
    await rejected(
      h,
      () => cancel(h, 1, 'again'),
      409,
      'ORDER_VERSION_CONFLICT',
    );
    await rejected(h, () => cancel(h, 2, 'third'), 409, 'ORDER_STATE_CONFLICT');
  });
  it('replays the stored response even after the order moved on, and rejects a different body under the same key', async () => {
    const h = harness();
    await h.service.createDraft('c', selected);
    const first = await cancel(h, 1);
    h.events.length = 0;
    expect(await cancel(h, 1)).toEqual(first);
    expect(h.events).not.toContain('order');
    await rejected(h, () => cancel(h, 2), 409, 'IDEMPOTENCY_KEY_CONFLICT');
    expect(
      h.state().audits.filter((audit) => audit.operation === 'CANCEL'),
    ).toHaveLength(1);
  });
  it('requires create:ProcurementOrderCancellation + read PO only; no update or catalog permissions', async () => {
    for (const denied of [
      'create:ProcurementOrderCancellation',
      'read:ProcurementPurchaseOrder',
    ]) {
      const h = harness();
      await h.service.createDraft('c', selected);
      h.setPermissions(
        h.permissions.filter((p) => `${p.action}:${p.subject}` !== denied),
      );
      await rejected(h, () => cancel(h, 1), 403, 'FORBIDDEN');
    }
    const h = harness();
    await h.service.createDraft('c', selected);
    h.setPermissions([
      { action: 'read', subject: 'ProcurementPurchaseOrder' },
      { action: 'create', subject: 'ProcurementOrderCancellation' },
    ]);
    expect((await cancel(h, 1)).body.status).toBe('CANCELLED');
    const confirmOnly = harness();
    await confirmOnly.service.createDraft('c', selected);
    confirmOnly.setPermissions([
      { action: 'read', subject: 'ProcurementPurchaseOrder' },
      { action: 'create', subject: 'ProcurementOrderConfirmation' },
    ]);
    await rejected(confirmOnly, () => cancel(confirmOnly, 1), 403, 'FORBIDDEN');
  });
  it('rejects malformed bodies, unknown orders and IN_FLIGHT without writes', async () => {
    const h = harness();
    await h.service.createDraft('c', selected);
    await rejected(
      h,
      () => h.service.cancel(id, 'x', { expectedVersion: 1, reason: 'no' }),
      400,
      'MALFORMED',
    );
    await rejected(
      h,
      () => h.service.cancel(otherId, 'x', { expectedVersion: 1 }),
      404,
      'NOT_FOUND',
    );
    h.flags.gate = false;
    await rejected(h, () => cancel(h, 1), 409, 'IDEMPOTENCY_KEY_IN_FLIGHT');
  });
  it.each(['failAudit', 'failReceipt'] as const)(
    'rolls the whole cancel back on %s, and a lost CAS emits no evidence',
    async (flag) => {
      const h = harness();
      await h.service.createDraft('c', selected);
      const before = structuredClone(h.state());
      h.flags[flag] = true;
      await expect(cancel(h, 1)).rejects.toMatchObject({
        code: 'INTERNAL_ERROR',
      });
      expect(h.state()).toEqual(before);
      h.flags[flag] = false;
      h.flags.casLost = true;
      await lostCas(h, () => cancel(h, 1));
    },
  );
});

describe('PurchaseOrderCommands state guards on existing endpoints (S6)', () => {
  it.each(['confirm', 'cancel'] as const)(
    'PUT and DELETE on a %s order: version CAS first, then ORDER_STATE_CONFLICT; earlier receipts still replay',
    async (transition) => {
      const h = harness();
      const created = await h.service.createDraft('c', selected);
      const saved = await replace(h, selected, 1, 'r-before');
      if (transition === 'confirm') await confirm(h, confirmBodyOf(saved.body));
      else await cancel(h, 2);
      await rejected(
        h,
        () => replace(h, selected, 1, 'r1'),
        409,
        'ORDER_VERSION_CONFLICT',
      );
      await rejected(
        h,
        () => h.service.deleteDraft(id, 'd1', { expectedVersion: 1 }),
        409,
        'ORDER_VERSION_CONFLICT',
      );
      await rejected(
        h,
        () => replace(h, selected, 3, 'r2'),
        409,
        'ORDER_STATE_CONFLICT',
      );
      await rejected(
        h,
        () => h.service.deleteDraft(id, 'd2', { expectedVersion: 3 }),
        409,
        'ORDER_STATE_CONFLICT',
      );
      expect(await replace(h, selected, 1, 'r-before')).toEqual(saved);
      expect(await h.service.createDraft('c', selected)).toEqual(created);
      expect(h.state().rows).toHaveLength(1);
    },
  );
});

describe('PurchaseOrderCommands S1 invariant: procurement tables only', () => {
  it('confirm and cancel touch no stock, reservation, payment, debt or outbox structure', async () => {
    const h = harness();
    const created = await h.service.createDraft('c', selected);
    const confirmed = await confirm(h, confirmBodyOf(created.body));
    await cancel(h, confirmed.body.version);
    expect(Object.keys(h.tx).sort()).toEqual(
      [
        '$executeRaw',
        '$queryRaw',
        'procurementPurchaseOrder',
        'procurementPurchaseOrderAudit',
        'procurementPurchaseOrderLine',
        'procurementPurchaseOrderReceipt',
      ].sort(),
    );
    const tables = new Set(
      h.sqls.flatMap((sql) =>
        [...sql.matchAll(/(?:FROM|JOIN)\s+"([a-z_]+)"/g)].map((m) => m[1]),
      ),
    );
    expect([...tables].sort()).toEqual(
      [
        'procurement_purchase_orders',
        'procurement_suppliers',
        'products',
        'roles',
        'role_permissions',
        'permissions',
        'tenant_memberships',
        'tenants',
        'users',
        'variants',
      ]
        .filter((name) => tables.has(name))
        .sort(),
    );
    for (const sql of h.sqls)
      expect(sql).not.toMatch(
        /\b(INSERT|UPDATE\s+"|DELETE\s+FROM|stock|reservation|payment|debt|outbox)/i,
      );
  });
});
