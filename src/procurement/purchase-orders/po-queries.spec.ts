import { Prisma } from '@prisma/client';
import type { ClsService } from 'nestjs-cls';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { PurchaseOrderQueries } from './po-queries';
import { PurchaseOrderCursor } from './po-cursor';

const id = '10000000-0000-4000-8000-000000000001';
const supplierId = '20000000-0000-4000-8000-000000000001';
const productId = '30000000-0000-4000-8000-000000000001';
const variantId = '40000000-0000-4000-8000-000000000001';
const lineId = '50000000-0000-4000-8000-000000000001';
const time = new Date('2026-01-01T00:00:00.000Z');
const line = {
  tenantId: 'tenant-a',
  orderId: id,
  lineId,
  position: 0,
  productId,
  variantId,
  orderedQuantity: '2.5',
  informedUnitCostPresent: true,
  costAmount: '4',
  currency: 'MXN',
  costUnit: 'KILOGRAMO',
  taxBasis: 'EXCLUDES_TAX',
  productName: 'Saved product',
  variantName: 'Saved variant',
  unitSnapshot: 'KILOGRAMO',
};
const row = {
  id,
  tenantId: 'tenant-a',
  supplierId,
  status: 'DRAFT',
  version: 7,
  note: ' note ',
  locationDetail: ' detail ',
  locationTenantName: 'Saved tenant',
  supplierDisplaySnapshot: {
    id: supplierId,
    displayName: 'Saved supplier',
    status: 'ACTIVE',
  },
  createdAt: time,
  updatedAt: time,
  lines: [line],
};
function harness() {
  const context: Record<string, unknown> = {
    userId: 'actor',
    tenantId: 'tenant-a',
  };
  const flags = { active: true, tenantActive: true, ambient: false };
  let grants = [{ action: 'read', subject: 'ProcurementPurchaseOrder' }];
  let rows = [row];
  let products = [
    {
      id: productId,
      name: 'Current product',
      type: 'PRODUCT',
      unit: 'KILOGRAMO',
      hasVariants: true,
    },
  ];
  let variants = [{ id: variantId, productId, name: 'Current variant' }];
  let suppliers = [
    { id: supplierId, displayName: 'Current supplier', status: 'ACTIVE' },
  ];
  const sqls: Prisma.Sql[] = [];
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn((sql: Prisma.Sql) => {
      sqls.push(sql);
      if (sql.sql.includes('FROM "tenants"'))
        return Promise.resolve([
          {
            id: context.tenantId,
            name: 'Current tenant',
            isActive: flags.tenantActive,
          },
        ]);
      if (sql.sql.includes('FROM "users"'))
        return Promise.resolve([
          { id: context.userId, isActive: flags.active },
        ]);
      if (sql.sql.includes('FROM "tenant_memberships"'))
        return Promise.resolve(grants);
      if (sql.sql.includes('FROM "procurement_purchase_orders"'))
        return Promise.resolve(rows);
      if (sql.sql.includes('FROM "procurement_suppliers"'))
        return Promise.resolve(suppliers);
      if (sql.sql.includes('FROM "products"')) return Promise.resolve(products);
      if (sql.sql.includes('FROM "variants"')) return Promise.resolve(variants);
      throw new Error('unexpected SQL');
    }),
  };
  const db = {
    getTenantId: () => context.tenantId,
    isInTransaction: () => flags.ambient,
    getClient: () => tx,
    runInTransaction: jest.fn((work: () => Promise<unknown>) => work()),
  };
  return {
    service: new PurchaseOrderQueries(
      db as unknown as TenantPrismaService,
      { get: (key: string) => context[key] } as ClsService<TenantClsStore>,
      new PurchaseOrderCursor('offline-only'),
    ),
    tx,
    db,
    flags,
    context,
    sqls,
    rows: (value: typeof rows) => {
      rows = value;
    },
    products: (value: typeof products) => {
      products = value;
    },
    variants: (value: typeof variants) => {
      variants = value;
    },
    suppliers: (value: typeof suppliers) => {
      suppliers = value;
    },
    grants: (value: typeof grants) => {
      grants = value;
    },
  };
}
describe('purchase-order read boundary', () => {
  it('builds full current detail with exact subtotal, no writes or version bump', async () => {
    const h = harness();
    const result = await h.service.getDraft(id);
    expect(result).toEqual({
      id,
      version: 7,
      status: 'DRAFT',
      supplierId,
      note: ' note ',
      location: { detail: ' detail ' },
      createdAt: time.toISOString(),
      updatedAt: time.toISOString(),
      lines: [
        {
          lineId,
          productId,
          variantId,
          orderedQuantity: '2.5',
          informedUnitCost: {
            amount: '4',
            currency: 'MXN',
            unit: 'KILOGRAMO',
            taxBasis: 'EXCLUDES_TAX',
          },
        },
      ],
      supplierDisplaySnapshot: {
        id: supplierId,
        displayName: 'Current supplier',
        status: 'ACTIVE',
      },
      lineDisplaySnapshots: [
        {
          lineId,
          productName: 'Current product',
          variantName: 'Current variant',
          unit: 'KILOGRAMO',
        },
      ],
      lineSubtotals: [
        {
          lineId,
          subtotal: { amount: '10', currency: 'MXN', taxBasis: 'EXCLUDES_TAX' },
        },
      ],
      locationSnapshot: {
        tenantId: 'tenant-a',
        tenantName: 'Current tenant',
        detail: ' detail ',
      },
      validation: { issues: [] },
    });
    expect(h.sqls[0].sql).toContain('FOR SHARE');
    expect(h.sqls[3].values).toEqual(['tenant-a', id]);
    expect(
      h.sqls
        .slice(3)
        .every(
          (sql) =>
            !/FOR UPDATE|FOR SHARE|INSERT|DELETE|UPDATE|COUNT\(/.test(sql.sql),
        ),
    ).toBe(true);
    expect(h.tx.$executeRaw).toHaveBeenCalledTimes(1); // lifecycle gate only
    expect(h.db.runInTransaction).toHaveBeenCalledWith(
      expect.any(Function),
      Prisma.TransactionIsolationLevel.ReadCommitted,
    );
  });
  it('keeps saved labels for invalidated references and recomputes issues/subtotals', async () => {
    const h = harness();
    h.products([]);
    h.variants([]);
    h.suppliers([
      { id: supplierId, displayName: 'Archived', status: 'ARCHIVED' },
    ]);
    const detail = await h.service.getDraft(id);
    expect(detail.version).toBe(7);
    expect(detail.lineDisplaySnapshots[0].productName).toBe('Saved product');
    expect(detail.lineSubtotals[0].subtotal).toBeNull();
    expect(detail.validation.issues).toEqual([
      { path: '/lines/0/productId', code: 'REFERENCE_UNAVAILABLE' },
      { path: '/lines/0/variantId', code: 'REFERENCE_UNAVAILABLE' },
      { path: '/supplierId', code: 'SUPPLIER_ARCHIVED' },
    ]);
    const page = await h.service.listDrafts({});
    expect(page.items[0].issueCount).toBe(detail.validation.issues.length);
  });
  it('batches references for the returned page, emits exact summary and fetches limit+1 without COUNT', async () => {
    const h = harness();
    h.rows([row, { ...row, id: '10000000-0000-4000-8000-000000000002' }, row]);
    const first = await h.service.listDrafts({ supplierId, limit: '2' });
    expect(first.items).toHaveLength(2);
    expect(first.items[0]).toEqual({
      id,
      version: 7,
      status: 'DRAFT',
      supplierDisplaySnapshot: {
        id: supplierId,
        displayName: 'Current supplier',
        status: 'ACTIVE',
      },
      lineCount: 1,
      issueCount: 0,
      note: ' note ',
      locationDetail: ' detail ',
      createdAt: time.toISOString(),
      updatedAt: time.toISOString(),
    });
    const business = h.sqls.slice(3);
    expect(business).toHaveLength(4);
    expect(business[0].sql).toContain(
      'ORDER BY o."createdAt" DESC, o."id" DESC',
    );
    expect(business[0].sql).toContain('jsonb_agg');
    expect(business[0].values).toEqual(['tenant-a', supplierId, 3]);
    for (const sql of business.slice(1))
      expect(sql.values).toEqual(['tenant-a', expect.any(String)]);
    h.rows([]);
    await h.service.listDrafts({
      supplierId,
      cursor: first.nextCursor,
      limit: '1',
    });
    expect(h.sqls[10].sql).toContain('(o."createdAt", o."id") <');
    await expect(
      h.service.listDrafts({ cursor: first.nextCursor }),
    ).rejects.toMatchObject({ code: 'MALFORMED' });
    h.context.tenantId = 'tenant-b';
    await expect(
      h.service.listDrafts({ supplierId, cursor: first.nextCursor }),
    ).rejects.toMatchObject({ code: 'MALFORMED' });
  });
  it.each([
    ['SERVICE', 'KILOGRAMO', 'REFERENCE_INCOMPATIBLE'],
    ['PRODUCT', 'CAJA', 'QUANTITY_FRACTION_NOT_ALLOWED'],
  ])('diagnoses retained product drift %s/%s', async (type, unit, code) => {
    const h = harness();
    h.products([
      { id: productId, name: 'Changed', type, unit, hasVariants: true },
    ]);
    const detail = await h.service.getDraft(id);
    expect(detail.validation.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code })]),
    );
    expect(detail.lineSubtotals[0].subtotal).toBeNull();
    expect(detail.lineDisplaySnapshots[0].productName).toBe('Saved product');
    const page = await h.service.listDrafts({});
    expect(page.items[0].issueCount).toBe(detail.validation.issues.length);
  });
  it('uses saved supplier when unavailable; never exposes a wrong-parent variant label', async () => {
    const h = harness();
    h.suppliers([]);
    h.variants([
      { id: variantId, productId: 'another-product', name: 'Must not leak' },
    ]);
    const detail = await h.service.getDraft(id);
    expect(detail.supplierDisplaySnapshot).toEqual(row.supplierDisplaySnapshot);
    expect(detail.lineDisplaySnapshots[0].variantName).toBe('Saved variant');
    expect(detail.validation.issues).toEqual([
      { path: '/lines/0/variantId', code: 'REFERENCE_INCOMPATIBLE' },
      { path: '/supplierId', code: 'REFERENCE_UNAVAILABLE' },
    ]);
  });
  it('handles empty/incomplete drafts without mutation', async () => {
    const h = harness();
    // Preserve the stored null-versus-present informed-cost distinction.
    h.rows([
      {
        ...row,
        lines: [{ ...line, informedUnitCostPresent: false }],
      },
    ]);
    const partial = await h.service.getDraft(id);
    expect(partial.lines[0].informedUnitCost).toBeNull();
    expect(partial.validation.issues).toHaveLength(4);
    h.rows([{ ...row, lines: [] }]);
    const empty = await h.service.getDraft(id);
    expect(empty.lines).toEqual([]);
    expect(empty.validation.issues).toEqual([
      { path: '/lines', code: 'LINES_REQUIRED' },
    ]);
  });
  it('defaults to 25, null cursor for empty page, no reference queries', async () => {
    const h = harness();
    h.rows([]);
    expect(await h.service.listDrafts({})).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(h.sqls[3].values).toEqual(['tenant-a', 26]);
    expect(h.sqls).toHaveLength(4);
    await expect(h.service.getDraft(id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it.each([
    ['active', 'UNAUTHORIZED'],
    ['tenantActive', 'FORBIDDEN'],
  ] as const)('denies %s before reading orders', async (flag, code) => {
    const h = harness();
    h.flags[flag] = false;
    await expect(h.service.getDraft(id)).rejects.toMatchObject({ code });
    expect(
      h.sqls.some((sql) => sql.sql.includes('procurement_purchase_orders')),
    ).toBe(false);
  });
  it.each(['create', 'update', 'delete'])(
    'does not infer read from %s or claims',
    async (action) => {
      const h = harness();
      h.context.isSuperAdmin = true;
      h.grants([{ action, subject: 'ProcurementPurchaseOrder' }]);
      await expect(h.service.getDraft(id)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    },
  );
  it('rechecks revocation; read PO alone suffices and manage:all remains valid', async () => {
    const h = harness();
    h.grants([{ action: 'manage', subject: 'all' }]);
    await h.service.getDraft(id);
    h.grants([]);
    await expect(h.service.getDraft(id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
  it.each([
    { limit: '101' },
    { limit: ['1'] },
    { supplierId: 'foreign' },
    { tenantId: 'other' },
  ])('rejects query %j before DB', async (query) => {
    const h = harness();
    await expect(h.service.listDrafts(query)).rejects.toMatchObject({
      code: 'MALFORMED',
    });
    expect(h.sqls).toHaveLength(0);
  });
  it('rejects missing CLS, ambient transactions and sanitizes driver failures', async () => {
    const h = harness();
    h.context.userId = undefined;
    await expect(h.service.getDraft(id)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    h.context.userId = 'actor';
    h.context.tenantId = undefined;
    await expect(h.service.getDraft(id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    h.context.tenantId = 'tenant-a';
    h.flags.ambient = true;
    await expect(h.service.getDraft(id)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
    h.flags.ambient = false;
    h.tx.$queryRaw.mockRejectedValueOnce(new Error('private'));
    await expect(h.service.getDraft(id)).rejects.toMatchObject({
      message: 'INTERNAL_ERROR',
    });
  });
});
