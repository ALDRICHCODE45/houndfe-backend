import { Prisma } from '@prisma/client';
import type { ClsService } from 'nestjs-cls';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { PurchaseOrderQueries } from './po-queries';
import { PurchaseOrderCursor } from './po-cursor';
import { computePurchaseOrderTotals } from './po-response';

const id = '10000000-0000-4000-8000-000000000001';
const supplierId = '20000000-0000-4000-8000-000000000001';
const productId = '30000000-0000-4000-8000-000000000001';
const variantId = '40000000-0000-4000-8000-000000000001';
const lineId = '50000000-0000-4000-8000-000000000001';
const time = new Date('2026-01-01T00:00:00.000Z');
const later = new Date('2026-02-03T04:05:06.007Z');
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
  confirmedAt: null as Date | null,
  confirmedByDisplayName: null as string | null,
  cancelledAt: null as Date | null,
  cancelledByDisplayName: null as string | null,
  lineSubtotalsSnapshot: null as unknown,
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
    {
      id: supplierId,
      displayName: 'Current supplier',
      status: 'ACTIVE',
      version: 4,
    },
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
      issueSummary: { cost: 0, quantity: 0, reference: 0, order: [] },
      checklistItemCount: 0,
      supplierCurrentVersion: 4,
      referenceToken: expect.stringMatching(/^prt1\.[\w-]{43}$/) as unknown,
      canConfirm: true,
      confirmedAt: null,
      confirmedBy: null,
      cancelledAt: null,
      cancelledBy: null,
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
      {
        id: supplierId,
        displayName: 'Archived',
        status: 'ARCHIVED',
        version: 4,
      },
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
    expect(detail.referenceToken).toBeNull();
    expect(detail.canConfirm).toBe(false);
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
      issueSummary: { cost: 0, quantity: 0, reference: 0, order: [] },
      checklistItemCount: 0,
      totals: [{ amount: '10', currency: 'MXN', taxBasis: 'EXCLUDES_TAX' }],
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
  it('searches the live supplier name for DRAFT and the frozen snapshot name for closed orders, OR note, with escaped literal ILIKE and supplier AND', async () => {
    const h = harness();
    h.rows([row, row]);
    const first = await h.service.listDrafts({
      supplierId,
      search: '  É_%\\\\  ',
      limit: '1',
    });
    const sql = h.sqls[3];
    expect(sql.sql).toContain('LEFT JOIN "procurement_suppliers" s');
    expect(sql.sql).toContain('s."tenantId" = o."tenantId"');
    expect(sql.sql).toContain('s."id" = o."supplierId"');
    expect(sql.sql).toContain('AND o."supplierId" =');
    expect(sql.sql).toMatch(
      /AND \(\(CASE WHEN o\."status" = 'DRAFT' THEN s\."displayName" ELSE o\."supplierDisplaySnapshot"->>'displayName' END\) ILIKE .* OR o\."note" ILIKE /s,
    );
    expect(sql.sql).toContain('ESCAPE chr(92)');
    expect(sql.sql).not.toMatch(/COUNT\(/);
    expect(sql.values).toEqual([
      'tenant-a',
      supplierId,
      '%É\\_\\%\\\\\\\\%',
      '%É\\_\\%\\\\\\\\%',
      2,
    ]);
    h.rows([]);
    await h.service.listDrafts({
      supplierId,
      search: 'É_%\\\\',
      cursor: first.nextCursor,
    });
    expect(h.sqls[10].sql).toContain('(o."createdAt", o."id") <');
    await expect(
      h.service.listDrafts({
        supplierId,
        search: 'é_%\\\\',
        cursor: first.nextCursor,
      }),
    ).rejects.toMatchObject({ code: 'MALFORMED' });
    await expect(
      h.service.listDrafts({ supplierId, cursor: first.nextCursor }),
    ).rejects.toMatchObject({ code: 'MALFORMED' });
  });
  it('treats blank search as absent and rejects arrays before DB', async () => {
    const h = harness();
    h.rows([]);
    await h.service.listDrafts({ search: '   ' });
    expect(h.sqls[3].values).toEqual(['tenant-a', 26]);
    expect(h.sqls[3].sql).not.toContain('ILIKE');
    const before = h.sqls.length;
    await expect(
      h.service.listDrafts({ search: ['term'] }),
    ).rejects.toMatchObject({ code: 'MALFORMED' });
    expect(h.sqls).toHaveLength(before);
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

  it('archived supplier keeps a token and version but canConfirm is false', async () => {
    const h = harness();
    h.suppliers([
      {
        id: supplierId,
        displayName: 'Archived',
        status: 'ARCHIVED',
        version: 6,
      },
    ]);
    const detail = await h.service.getDraft(id);
    expect(detail.supplierCurrentVersion).toBe(6);
    expect(detail.referenceToken).not.toBeNull();
    expect(detail.validation.issues).toEqual([
      { path: '/supplierId', code: 'SUPPLIER_ARCHIVED' },
    ]);
    expect(detail.canConfirm).toBe(false);
  });
  it('does not leak the supplier version into the supplier snapshot', async () => {
    const h = harness();
    const detail = await h.service.getDraft(id);
    expect(detail.supplierDisplaySnapshot).toEqual({
      id: supplierId,
      displayName: 'Current supplier',
      status: 'ACTIVE',
    });
  });
  it('detail serves every status without a DRAFT-only SQL filter', async () => {
    const h = harness();
    await h.service.getDraft(id);
    expect(h.sqls[3].sql).not.toMatch(/status/);
  });
  const confirmedRow = {
    ...row,
    status: 'CONFIRMED',
    version: 8,
    updatedAt: later,
    confirmedAt: later,
    confirmedByDisplayName: 'Ana Compras',
    lineSubtotalsSnapshot: [
      {
        lineId,
        subtotal: {
          amount: '10',
          currency: 'MXN',
          taxBasis: 'EXCLUDES_TAX',
        },
      },
    ],
  };
  it('reads CONFIRMED frozen: stored names/subtotals, no live product/variant/tenant names, no issues', async () => {
    const h = harness();
    h.rows([confirmedRow]);
    // Live data drifted after confirmation.
    h.products([]);
    h.variants([]);
    h.suppliers([
      {
        id: supplierId,
        displayName: 'Renamed later',
        status: 'ARCHIVED',
        version: 11,
      },
    ]);
    const detail = await h.service.getDraft(id);
    expect(detail).toMatchObject({
      status: 'CONFIRMED',
      version: 8,
      supplierDisplaySnapshot: {
        id: supplierId,
        displayName: 'Saved supplier',
        status: 'ACTIVE',
      },
      lineDisplaySnapshots: [
        {
          lineId,
          productName: 'Saved product',
          variantName: 'Saved variant',
          unit: 'KILOGRAMO',
        },
      ],
      lineSubtotals: [{ lineId, subtotal: { amount: '10' } }],
      locationSnapshot: { tenantName: 'Saved tenant' },
      validation: { issues: [] },
      issueSummary: { cost: 0, quantity: 0, reference: 0, order: [] },
      checklistItemCount: 0,
      referenceToken: null,
      canConfirm: false,
      supplierCurrentVersion: 11,
      confirmedAt: later.toISOString(),
      confirmedBy: { displayName: 'Ana Compras' },
      cancelledAt: null,
      cancelledBy: null,
    });
    // Only the order and the supplier version are read for a closed order.
    const business = h.sqls.slice(3).map((sql) => sql.sql);
    expect(business.some((sql) => sql.includes('FROM "products"'))).toBe(false);
    expect(business.some((sql) => sql.includes('FROM "variants"'))).toBe(false);
  });
  it('reads CANCELLED-from-DRAFT with null subtotals and no supplier read when none is set', async () => {
    const h = harness();
    h.rows([
      {
        ...row,
        status: 'CANCELLED',
        supplierId: null as unknown as string,
        supplierDisplaySnapshot:
          null as unknown as typeof row.supplierDisplaySnapshot,
        cancelledAt: later,
        cancelledByDisplayName: 'Luis Gerente',
      },
    ]);
    const detail = await h.service.getDraft(id);
    expect(detail).toMatchObject({
      status: 'CANCELLED',
      supplierDisplaySnapshot: null,
      supplierCurrentVersion: null,
      lineSubtotals: [{ lineId, subtotal: null }],
      validation: { issues: [] },
      issueSummary: { cost: 0, quantity: 0, reference: 0, order: [] },
      checklistItemCount: 0,
      canConfirm: false,
      referenceToken: null,
      cancelledAt: later.toISOString(),
      cancelledBy: { displayName: 'Luis Gerente' },
      confirmedBy: null,
    });
    expect(
      h.sqls
        .slice(3)
        .some((sql) => sql.sql.includes('FROM "procurement_suppliers"')),
    ).toBe(false);
  });
  it('lists every status by default, with zero issues for closed orders', async () => {
    const h = harness();
    h.rows([
      row,
      confirmedRow,
      { ...confirmedRow, status: 'CANCELLED', cancelledAt: later },
    ]);
    const page = await h.service.listDrafts({});
    expect(page.items.map((item) => item.status)).toEqual([
      'DRAFT',
      'CONFIRMED',
      'CANCELLED',
    ]);
    expect(page.items.map((item) => item.issueCount)).toEqual([0, 0, 0]);
    expect(h.sqls[3].sql).not.toMatch(/"status"/);
    expect(h.sqls[3].values).toEqual(['tenant-a', 26]);
  });
  it('filters by one status as a bound enum parameter and binds the cursor to it', async () => {
    const h = harness();
    h.rows([confirmedRow, confirmedRow]);
    const first = await h.service.listDrafts({
      status: 'CONFIRMED',
      limit: '1',
    });
    expect(h.sqls[3].sql).toContain('o."status" =');
    expect(h.sqls[3].sql).toContain('::"ProcurementPurchaseOrderStatus"');
    expect(h.sqls[3].sql).not.toContain("'DRAFT'");
    expect(h.sqls[3].values).toEqual(['tenant-a', 'CONFIRMED', 2]);
    expect(first.nextCursor).not.toBeNull();
    h.rows([]);
    await h.service.listDrafts({
      status: 'CONFIRMED',
      cursor: first.nextCursor,
    });
    for (const other of [{}, { status: 'DRAFT' }, { status: 'CANCELLED' }])
      await expect(
        h.service.listDrafts({ ...other, cursor: first.nextCursor }),
      ).rejects.toMatchObject({ code: 'MALFORMED' });
  });
  it.each([
    { status: 'ALL' },
    { status: 'draft' },
    { status: ['DRAFT', 'CONFIRMED'] },
    { status: '' },
  ])('rejects status %j before DB', async (query) => {
    const h = harness();
    await expect(h.service.listDrafts(query)).rejects.toMatchObject({
      code: 'MALFORMED',
    });
    expect(h.sqls).toHaveLength(0);
  });

  describe('list totals per tax basis', () => {
    const secondLineId = '50000000-0000-4000-8000-000000000002';
    const secondLine = {
      ...line,
      lineId: secondLineId,
      position: 1,
      orderedQuantity: '1',
      costAmount: '116',
      taxBasis: 'INCLUDES_TAX',
    };
    const frozen = (amount: string, taxBasis: string, id = lineId) => ({
      lineId: id,
      subtotal: { amount, currency: 'MXN', taxBasis },
    });
    it('DRAFT uses the live-validated subtotals the detail returns (single and mixed)', async () => {
      const h = harness();
      h.rows([
        row,
        {
          ...row,
          id: '10000000-0000-4000-8000-000000000002',
          lines: [line, secondLine],
        },
      ]);
      const page = await h.service.listDrafts({});
      expect(page.items.map((item) => item.totals)).toEqual([
        [{ amount: '10', currency: 'MXN', taxBasis: 'EXCLUDES_TAX' }],
        [
          { amount: '10', currency: 'MXN', taxBasis: 'EXCLUDES_TAX' },
          { amount: '116', currency: 'MXN', taxBasis: 'INCLUDES_TAX' },
        ],
      ]);
      h.rows([{ ...row, lines: [line, secondLine] }]);
      const detail = await h.service.getDraft(id);
      expect(computePurchaseOrderTotals(detail.lineSubtotals)).toEqual(
        (await h.service.listDrafts({})).items[0].totals,
      );
    });
    it('DRAFT totals are null for zero lines, incomplete lines and invalid references', async () => {
      const h = harness();
      h.rows([
        { ...row, lines: [] },
        { ...row, lines: [{ ...line, informedUnitCostPresent: false }] },
        { ...row, lines: [line, { ...secondLine, orderedQuantity: null }] },
      ] as unknown as (typeof row)[]);
      expect(
        (await h.service.listDrafts({})).items.map((item) => item.totals),
      ).toEqual([null, null, null]);
      h.rows([row]);
      h.products([]);
      expect((await h.service.listDrafts({})).items[0].totals).toBeNull();
    });
    it('CONFIRMED uses the frozen snapshot only, never drifted live data', async () => {
      const h = harness();
      h.rows([
        {
          ...row,
          status: 'CONFIRMED',
          lines: [line, secondLine],
          lineSubtotalsSnapshot: [
            frozen('0.1', 'EXCLUDES_TAX'),
            frozen('0.2', 'EXCLUDES_TAX', secondLineId),
          ],
        },
        {
          ...row,
          id: '10000000-0000-4000-8000-000000000002',
          status: 'CONFIRMED',
          lines: [line, secondLine],
          lineSubtotalsSnapshot: [
            frozen('99', 'INCLUDES_TAX'),
            frozen('1.5', 'EXCLUDES_TAX', secondLineId),
          ],
        },
      ]);
      h.products([]);
      h.variants([]);
      const page = await h.service.listDrafts({});
      expect(page.items.map((item) => item.totals)).toEqual([
        [{ amount: '0.3', currency: 'MXN', taxBasis: 'EXCLUDES_TAX' }],
        [
          { amount: '1.5', currency: 'MXN', taxBasis: 'EXCLUDES_TAX' },
          { amount: '99', currency: 'MXN', taxBasis: 'INCLUDES_TAX' },
        ],
      ]);
      const business = h.sqls.slice(3).map((sql) => sql.sql);
      expect(business.some((sql) => sql.includes('FROM "products"'))).toBe(
        false,
      );
    });
    it('CANCELLED-from-CONFIRMED keeps the snapshot total; CANCELLED-from-DRAFT is null', async () => {
      const h = harness();
      h.rows([
        {
          ...row,
          status: 'CANCELLED',
          lineSubtotalsSnapshot: [frozen('10', 'EXCLUDES_TAX')],
        },
        { ...row, status: 'CANCELLED', lineSubtotalsSnapshot: null },
        {
          ...row,
          status: 'CONFIRMED',
          lineSubtotalsSnapshot: [] as unknown,
        },
      ]);
      expect(
        (await h.service.listDrafts({})).items.map((item) => item.totals),
      ).toEqual([
        [{ amount: '10', currency: 'MXN', taxBasis: 'EXCLUDES_TAX' }],
        null,
        null,
      ]);
    });
    it('adds no per-order queries and no locks; the detail has no totals', async () => {
      const h = harness();
      h.rows([
        row,
        { ...row, id: '10000000-0000-4000-8000-000000000002' },
        { ...row, id: '10000000-0000-4000-8000-000000000003' },
      ]);
      await h.service.listDrafts({});
      const business = h.sqls.slice(3);
      expect(business).toHaveLength(4);
      expect(
        business.every(
          (sql) => !/FOR UPDATE|FOR SHARE|INSERT|DELETE|UPDATE/.test(sql.sql),
        ),
      ).toBe(true);
      const detail = await h.service.getDraft(id);
      expect(detail).not.toHaveProperty('totals');
      expect(Object.keys(detail).sort()).toEqual(
        [
          'id',
          'version',
          'status',
          'supplierId',
          'note',
          'location',
          'createdAt',
          'updatedAt',
          'lines',
          'supplierDisplaySnapshot',
          'lineDisplaySnapshots',
          'lineSubtotals',
          'issueSummary',
          'checklistItemCount',
          'locationSnapshot',
          'validation',
          'supplierCurrentVersion',
          'referenceToken',
          'canConfirm',
          'confirmedAt',
          'confirmedBy',
          'cancelledAt',
          'cancelledBy',
        ].sort(),
      );
    });
  });
});
