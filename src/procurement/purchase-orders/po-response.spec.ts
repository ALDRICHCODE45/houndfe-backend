import type {
  ProcurementPurchaseOrder,
  ProcurementPurchaseOrderLine,
} from '@prisma/client';
import type { LineSubtotal, OrderInput } from './po-contract';
import {
  buildPurchaseOrder,
  canConfirmPurchaseOrder,
  computePurchaseOrderTotals,
  storedOrderInput,
} from './po-response';
import type { PurchaseOrderReferenceFacts } from './po-validation';

const tenantId = 'tenant-a';
const id = '10000000-0000-4000-8000-000000000001';
const supplierId = '20000000-0000-4000-8000-000000000001';
const productId = '30000000-0000-4000-8000-000000000001';
const lineId = '50000000-0000-4000-8000-000000000001';
const time = new Date('2026-01-01T00:00:00.000Z');
const later = new Date('2026-02-03T04:05:06.007Z');

const header = (
  overrides: Partial<ProcurementPurchaseOrder> = {},
): ProcurementPurchaseOrder => ({
  id,
  tenantId,
  supplierId,
  status: 'DRAFT',
  version: 3,
  note: null,
  locationDetail: null,
  locationTenantName: 'Stored branch',
  supplierDisplaySnapshot: {
    id: supplierId,
    displayName: 'Stored supplier',
    status: 'ACTIVE',
  },
  confirmedAt: null,
  confirmedByDisplayName: null,
  cancelledAt: null,
  cancelledByDisplayName: null,
  lineSubtotalsSnapshot: null,
  createdAt: time,
  updatedAt: time,
  ...overrides,
});
const stored = (): ProcurementPurchaseOrderLine => ({
  tenantId,
  orderId: id,
  lineId,
  position: 0,
  productId,
  variantId: null,
  orderedQuantity: '2',
  informedUnitCostPresent: true,
  costAmount: '1.25',
  currency: 'MXN',
  costUnit: 'CAJA',
  taxBasis: 'EXCLUDES_TAX',
  productName: 'Stored boxes',
  variantName: null,
  unitSnapshot: 'CAJA',
});
const order = (): OrderInput => storedOrderInput(header(), [stored()]);
const facts = (
  supplier: PurchaseOrderReferenceFacts['supplier'] = 'ACTIVE',
): PurchaseOrderReferenceFacts => ({
  supplier,
  lines: {
    [lineId]: {
      product: { type: 'PRODUCT', unit: 'CAJA', hasVariants: false },
      variant: 'missing',
    },
  },
});
const draft = (
  options: {
    row?: Partial<ProcurementPurchaseOrder>;
    order?: OrderInput;
    facts?: PurchaseOrderReferenceFacts;
    supplierVersion?: number | null;
  } = {},
) =>
  buildPurchaseOrder(
    header(options.row),
    options.supplierVersion === undefined ? 4 : options.supplierVersion,
    {
      order: options.order ?? order(),
      facts: options.facts ?? facts(),
      tenantName: 'Live branch',
      displays: () => ({
        supplierDisplaySnapshot: {
          id: supplierId,
          displayName: 'Live supplier',
          status:
            options.facts?.supplier === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE',
        },
        lineDisplaySnapshots: [
          {
            lineId,
            productName: 'Live boxes',
            variantName: null,
            unit: 'CAJA',
          },
        ],
      }),
    },
  );

describe('shared purchase-order response builder (DRAFT)', () => {
  it('is confirmable only when complete, referenced, versioned and supplier active', () => {
    const result = draft();
    expect(result).toMatchObject({
      id,
      version: 3,
      status: 'DRAFT',
      supplierCurrentVersion: 4,
      canConfirm: true,
      confirmedAt: null,
      confirmedBy: null,
      cancelledAt: null,
      cancelledBy: null,
      validation: { issues: [] },
      supplierDisplaySnapshot: { displayName: 'Live supplier' },
      locationSnapshot: { tenantId, tenantName: 'Live branch', detail: null },
    });
    expect(result.referenceToken).toMatch(/^prt1\./);
  });
  it('canConfirm is false for an ARCHIVED supplier (FE requirement)', () => {
    const result = draft({ facts: facts('ARCHIVED') });
    expect(result.supplierDisplaySnapshot?.status).toBe('ARCHIVED');
    expect(result.validation.issues).toEqual([
      { path: '/supplierId', code: 'SUPPLIER_ARCHIVED' },
    ]);
    expect(result.supplierCurrentVersion).toBe(4);
    expect(result.referenceToken).not.toBeNull();
    expect(result.canConfirm).toBe(false);
  });
  it('canConfirm is false when the supplier is archived even with no other signal', () => {
    // Defence in depth: the explicit S3 clause must not rely on issues alone.
    expect(
      canConfirmPurchaseOrder({
        status: 'DRAFT',
        issueCount: 0,
        referenceToken: 'prt1.x',
        supplierCurrentVersion: 4,
        supplierStatus: 'ARCHIVED',
      }),
    ).toBe(false);
    const ok = {
      status: 'DRAFT' as const,
      issueCount: 0,
      referenceToken: 'prt1.x',
      supplierCurrentVersion: 4,
      supplierStatus: 'ACTIVE' as const,
    };
    expect(canConfirmPurchaseOrder(ok)).toBe(true);
    for (const override of [
      { status: 'CONFIRMED' as const },
      { status: 'CANCELLED' as const },
      { issueCount: 1 },
      { referenceToken: null },
      { supplierCurrentVersion: null },
      { supplierStatus: null },
    ])
      expect(canConfirmPurchaseOrder({ ...ok, ...override })).toBe(false);
  });
  it.each([
    ['issues present (missing cost)', { informedUnitCost: null }],
    ['quantity missing', { orderedQuantity: null }],
  ])(
    'canConfirm is false with %s while the token stays non-null',
    (_n, patch) => {
      const base = order();
      const result = draft({
        order: { ...base, lines: [{ ...base.lines[0], ...patch }] },
      });
      expect(result.validation.issues.length).toBeGreaterThan(0);
      expect(result.referenceToken).not.toBeNull();
      expect(result.canConfirm).toBe(false);
    },
  );
  it('canConfirm is false and token null without supplier, lines or valid references', () => {
    const noSupplier = draft({
      row: { supplierId: null },
      order: { ...order(), supplierId: null },
      facts: facts('missing'),
      supplierVersion: null,
    });
    expect(noSupplier).toMatchObject({
      supplierCurrentVersion: null,
      referenceToken: null,
      canConfirm: false,
      supplierDisplaySnapshot: null,
    });
    expect(draft({ order: { ...order(), lines: [] } })).toMatchObject({
      referenceToken: null,
      canConfirm: false,
    });
    expect(
      draft({
        facts: {
          supplier: 'ACTIVE',
          lines: {
            [lineId]: {
              product: { type: 'SERVICE', unit: 'CAJA', hasVariants: false },
              variant: 'missing',
            },
          },
        },
      }),
    ).toMatchObject({ referenceToken: null, canConfirm: false });
  });
  it('canConfirm is false when the live supplier version is absent', () => {
    const result = draft({ supplierVersion: null });
    expect(result.referenceToken).not.toBeNull();
    expect(result.validation.issues).toEqual([]);
    expect(result).toMatchObject({
      supplierCurrentVersion: null,
      canConfirm: false,
    });
  });
  it('uses the same shape for every caller (key set and stable token)', () => {
    const first = draft();
    const second = draft({ row: { version: 9, updatedAt: later } });
    expect(Object.keys(first).sort()).toEqual(Object.keys(second).sort());
    expect(second.referenceToken).toBe(first.referenceToken);
    expect(Object.keys(first)).toEqual(
      expect.arrayContaining([
        'supplierCurrentVersion',
        'referenceToken',
        'canConfirm',
        'confirmedAt',
        'confirmedBy',
        'cancelledAt',
        'cancelledBy',
      ]),
    );
  });
  it('rejects a DRAFT row with no live source instead of reading frozen columns', () => {
    expect(() =>
      buildPurchaseOrder(header(), 4, { lines: [stored()] }),
    ).toThrow();
  });
});

describe('shared purchase-order response builder (closed orders)', () => {
  const confirmedRow = header({
    status: 'CONFIRMED',
    version: 4,
    updatedAt: later,
    confirmedAt: later,
    confirmedByDisplayName: 'Ana Compras',
    lineSubtotalsSnapshot: [
      {
        lineId,
        subtotal: { amount: '2.5', currency: 'MXN', taxBasis: 'EXCLUDES_TAX' },
      },
    ],
  });
  it('reads only stored columns for CONFIRMED and ignores live references', () => {
    const result = buildPurchaseOrder(confirmedRow, 9, { lines: [stored()] });
    expect(result).toEqual({
      id,
      version: 4,
      status: 'CONFIRMED',
      supplierId,
      note: null,
      location: { detail: null },
      createdAt: time.toISOString(),
      updatedAt: later.toISOString(),
      lines: order().lines,
      supplierDisplaySnapshot: {
        id: supplierId,
        displayName: 'Stored supplier',
        status: 'ACTIVE',
      },
      lineDisplaySnapshots: [
        {
          lineId,
          productName: 'Stored boxes',
          variantName: null,
          unit: 'CAJA',
        },
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
      locationSnapshot: {
        tenantId,
        tenantName: 'Stored branch',
        detail: null,
      },
      validation: { issues: [] },
      supplierCurrentVersion: 9,
      referenceToken: null,
      canConfirm: false,
      confirmedAt: later.toISOString(),
      confirmedBy: { displayName: 'Ana Compras' },
      cancelledAt: null,
      cancelledBy: null,
    });
  });
  it('keeps confirmed subtotals and snapshots after a later cancel', () => {
    const cancelled = header({
      ...confirmedRow,
      status: 'CANCELLED',
      version: 5,
      cancelledAt: later,
      cancelledByDisplayName: 'Luis Gerente',
    });
    const result = buildPurchaseOrder(cancelled, null, { lines: [stored()] });
    expect(result).toMatchObject({
      status: 'CANCELLED',
      supplierCurrentVersion: null,
      canConfirm: false,
      referenceToken: null,
      confirmedAt: later.toISOString(),
      confirmedBy: { displayName: 'Ana Compras' },
      cancelledAt: later.toISOString(),
      cancelledBy: { displayName: 'Luis Gerente' },
      lineSubtotals: [{ lineId, subtotal: { amount: '2.5' } }],
      supplierDisplaySnapshot: { displayName: 'Stored supplier' },
    });
  });
  it('CANCELLED-from-DRAFT has no frozen subtotal: one null entry per line, no live names', () => {
    const cancelled = header({
      status: 'CANCELLED',
      cancelledAt: later,
      cancelledByDisplayName: 'Luis Gerente',
    });
    const result = buildPurchaseOrder(cancelled, 2, { lines: [stored()] });
    expect(result.lineSubtotals).toEqual([{ lineId, subtotal: null }]);
    expect(result.validation.issues).toEqual([]);
    expect(result).toMatchObject({
      confirmedAt: null,
      confirmedBy: null,
      cancelledBy: { displayName: 'Luis Gerente' },
      locationSnapshot: { tenantName: 'Stored branch' },
      lineDisplaySnapshots: [{ productName: 'Stored boxes' }],
    });
  });
  it('is null-safe for cancelled drafts with no supplier or lines', () => {
    const result = buildPurchaseOrder(
      header({
        status: 'CANCELLED',
        supplierId: null,
        supplierDisplaySnapshot: null,
        cancelledAt: later,
        cancelledByDisplayName: 'Luis Gerente',
      }),
      null,
      { lines: [] },
    );
    expect(result).toMatchObject({
      supplierId: null,
      supplierDisplaySnapshot: null,
      lines: [],
      lineSubtotals: [],
      lineDisplaySnapshots: [],
      supplierCurrentVersion: null,
    });
  });
});

describe('computePurchaseOrderTotals', () => {
  const sub = (
    amount: string,
    taxBasis: 'EXCLUDES_TAX' | 'INCLUDES_TAX',
    n = 1,
  ): LineSubtotal => ({
    lineId: `50000000-0000-4000-8000-00000000000${n}`,
    subtotal: { amount, currency: 'MXN', taxBasis },
  });
  const empty = (n = 9): LineSubtotal => ({
    lineId: `50000000-0000-4000-8000-00000000000${n}`,
    subtotal: null,
  });
  it('returns one entry when every line shares a basis', () => {
    expect(
      computePurchaseOrderTotals([
        sub('10', 'INCLUDES_TAX', 1),
        sub('5.5', 'INCLUDES_TAX', 2),
      ]),
    ).toEqual([{ amount: '15.5', currency: 'MXN', taxBasis: 'INCLUDES_TAX' }]);
    expect(computePurchaseOrderTotals([sub('10', 'EXCLUDES_TAX')])).toEqual([
      { amount: '10', currency: 'MXN', taxBasis: 'EXCLUDES_TAX' },
    ]);
  });
  it('never sums across bases and always orders EXCLUDES_TAX then INCLUDES_TAX', () => {
    expect(
      computePurchaseOrderTotals([
        sub('100', 'INCLUDES_TAX', 1),
        sub('10', 'EXCLUDES_TAX', 2),
        sub('16', 'INCLUDES_TAX', 3),
        sub('2.5', 'EXCLUDES_TAX', 4),
      ]),
    ).toEqual([
      { amount: '12.5', currency: 'MXN', taxBasis: 'EXCLUDES_TAX' },
      { amount: '116', currency: 'MXN', taxBasis: 'INCLUDES_TAX' },
    ]);
    expect(
      computePurchaseOrderTotals([
        sub('10', 'EXCLUDES_TAX', 1),
        sub('100', 'INCLUDES_TAX', 2),
      ])?.map((entry) => entry.taxBasis),
    ).toEqual(['EXCLUDES_TAX', 'INCLUDES_TAX']);
  });
  it('is null for zero lines or when any subtotal is null', () => {
    expect(computePurchaseOrderTotals([])).toBeNull();
    expect(computePurchaseOrderTotals([empty()])).toBeNull();
    expect(
      computePurchaseOrderTotals([sub('10', 'EXCLUDES_TAX'), empty()]),
    ).toBeNull();
    expect(
      computePurchaseOrderTotals([empty(), sub('10', 'INCLUDES_TAX')]),
    ).toBeNull();
  });
  it('sums exact decimals without floats or trailing zeros', () => {
    expect(
      computePurchaseOrderTotals([
        sub('0.1', 'EXCLUDES_TAX', 1),
        sub('0.2', 'EXCLUDES_TAX', 2),
      ]),
    ).toEqual([{ amount: '0.3', currency: 'MXN', taxBasis: 'EXCLUDES_TAX' }]);
    expect(
      computePurchaseOrderTotals([
        sub('0.25', 'INCLUDES_TAX', 1),
        sub('0.75', 'INCLUDES_TAX', 2),
      ]),
    ).toEqual([{ amount: '1', currency: 'MXN', taxBasis: 'INCLUDES_TAX' }]);
    expect(
      computePurchaseOrderTotals([
        sub('0.0000001', 'INCLUDES_TAX', 1),
        sub('999999999998999900000', 'INCLUDES_TAX', 2),
      ]),
    ).toEqual([
      {
        amount: '999999999998999900000.0000001',
        currency: 'MXN',
        taxBasis: 'INCLUDES_TAX',
      },
    ]);
  });
});
