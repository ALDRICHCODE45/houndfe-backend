import { OrderInput, OrderLine } from './po-contract';
import {
  buildPurchaseOrderDiagnostics,
  PurchaseOrderReferenceFacts,
  PurchaseOrderLineReferenceFacts,
} from './po-validation';

const id = '10000000-0000-4000-8000-000000000001';
const productId = '10000000-0000-4000-8000-000000000002';
const variantId = '10000000-0000-4000-8000-000000000003';
const line = (): OrderLine => ({
  lineId: id,
  productId,
  variantId: null,
  orderedQuantity: '2.5',
  informedUnitCost: {
    amount: '0.20',
    currency: 'MXN',
    unit: 'KILOGRAMO',
    taxBasis: 'INCLUDES_TAX',
  },
});
const order = (item = line()): OrderInput => ({
  supplierId: id,
  note: null,
  location: { detail: null },
  lines: [item],
});
const facts = (): PurchaseOrderReferenceFacts => ({
  supplier: 'ACTIVE',
  lines: {
    [id]: {
      product: { type: 'PRODUCT', unit: 'KILOGRAMO', hasVariants: false },
      variant: 'missing',
    },
  },
});

describe('draft diagnostics', () => {
  it('produces exact subtotals without total, taxes or mutation', () => {
    const body = order();
    const before = JSON.stringify(body);
    expect(buildPurchaseOrderDiagnostics(body, facts())).toEqual({
      issues: [],
      lineSubtotals: [
        {
          lineId: id,
          subtotal: {
            amount: '0.5',
            currency: 'MXN',
            taxBasis: 'INCLUDES_TAX',
          },
        },
      ],
    });
    expect(JSON.stringify(body)).toBe(before);
    body.lines[0].informedUnitCost!.amount = '0';
    expect(
      buildPurchaseOrderDiagnostics(body, facts()).lineSubtotals[0].subtotal!
        .amount,
    ).toBe('0');
  });
  it('diagnoses empty orders and incomplete fields', () => {
    expect(
      buildPurchaseOrderDiagnostics(
        { ...order(), supplierId: null, lines: [] },
        facts(),
      ).issues,
    ).toEqual([
      { path: '/lines', code: 'LINES_REQUIRED' },
      { path: '/supplierId', code: 'SUPPLIER_REQUIRED' },
    ]);
    const result = buildPurchaseOrderDiagnostics(
      order({
        ...line(),
        productId: null,
        orderedQuantity: null,
        informedUnitCost: null,
      }),
      facts(),
    );
    expect(result.issues).toEqual([
      {
        path: '/lines/0/informedUnitCost/amount',
        code: 'COST_AMOUNT_REQUIRED',
      },
      {
        path: '/lines/0/informedUnitCost/currency',
        code: 'COST_CURRENCY_REQUIRED',
      },
      {
        path: '/lines/0/informedUnitCost/taxBasis',
        code: 'COST_TAX_BASIS_REQUIRED',
      },
      { path: '/lines/0/informedUnitCost/unit', code: 'COST_UNIT_REQUIRED' },
      { path: '/lines/0/orderedQuantity', code: 'QUANTITY_REQUIRED' },
      { path: '/lines/0/productId', code: 'PRODUCT_REQUIRED' },
    ]);
    expect(result.lineSubtotals).toEqual([{ lineId: id, subtotal: null }]);
  });
  it('diagnoses supplier status independently of line completeness', () => {
    for (const [supplier, code] of [
      ['missing', 'REFERENCE_UNAVAILABLE'],
      ['ARCHIVED', 'SUPPLIER_ARCHIVED'],
    ] as const) {
      const result = buildPurchaseOrderDiagnostics(order(), {
        ...facts(),
        supplier,
      });
      expect(result.issues).toEqual([{ path: '/supplierId', code }]);
      expect(result.lineSubtotals[0].subtotal).not.toBeNull();
    }
  });
  it('diagnoses invalid references, units and retained fractions', () => {
    const product = {
      type: 'PRODUCT',
      unit: 'KILOGRAMO',
      hasVariants: true,
    } as const;
    const cases: Array<{
      refs: PurchaseOrderLineReferenceFacts;
      item: OrderLine;
      path: string;
      code: string;
    }> = [
      {
        refs: { product: 'missing', variant: 'missing' },
        item: line(),
        path: 'productId',
        code: 'REFERENCE_UNAVAILABLE',
      },
      {
        refs: {
          product: { ...product, type: 'SERVICE', hasVariants: false },
          variant: 'missing',
        },
        item: line(),
        path: 'productId',
        code: 'REFERENCE_INCOMPATIBLE',
      },
      {
        refs: { product, variant: 'missing' },
        item: line(),
        path: 'variantId',
        code: 'VARIANT_REQUIRED',
      },
      {
        refs: { product, variant: 'missing' },
        item: { ...line(), variantId },
        path: 'variantId',
        code: 'REFERENCE_UNAVAILABLE',
      },
      {
        refs: { product, variant: { belongsToProduct: false } },
        item: { ...line(), variantId },
        path: 'variantId',
        code: 'REFERENCE_INCOMPATIBLE',
      },
      {
        refs: {
          product: { ...product, hasVariants: false },
          variant: { belongsToProduct: true },
        },
        item: { ...line(), variantId },
        path: 'variantId',
        code: 'REFERENCE_INCOMPATIBLE',
      },
    ];
    for (const { refs, item, path, code } of cases) {
      const result = buildPurchaseOrderDiagnostics(order(item), {
        supplier: 'ACTIVE',
        lines: { [id]: refs },
      });
      expect(result.issues).toContainEqual({ path: `/lines/0/${path}`, code });
      expect(result.lineSubtotals[0].subtotal).toBeNull();
    }
    const result = buildPurchaseOrderDiagnostics(order(), {
      supplier: 'ACTIVE',
      lines: {
        [id]: {
          product: { type: 'PRODUCT', unit: 'UNIDAD', hasVariants: false },
          variant: 'missing',
        },
      },
    });
    expect(result.issues).toEqual([
      { path: '/lines/0/informedUnitCost/unit', code: 'UNIT_MISMATCH' },
      {
        path: '/lines/0/orderedQuantity',
        code: 'QUANTITY_FRACTION_NOT_ALLOWED',
      },
    ]);
    expect(result.lineSubtotals[0].subtotal).toBeNull();
  });
  it('handles absent facts as unavailable and complete variants as valid', () => {
    expect(
      buildPurchaseOrderDiagnostics(order(), {
        supplier: 'ACTIVE',
        lines: {},
      }).issues,
    ).toEqual([{ path: '/lines/0/productId', code: 'REFERENCE_UNAVAILABLE' }]);
    const resolved: PurchaseOrderReferenceFacts = {
      supplier: 'ACTIVE',
      lines: {
        [id]: {
          product: { type: 'PRODUCT', unit: 'KILOGRAMO', hasVariants: true },
          variant: { belongsToProduct: true },
        },
      },
    };
    expect(
      buildPurchaseOrderDiagnostics(order({ ...line(), variantId }), resolved)
        .issues,
    ).toEqual([]);
  });
  it.each(['amount', 'currency', 'unit', 'taxBasis'] as const)(
    'null %s suppresses subtotal',
    (key) => {
      const item = line();
      item.informedUnitCost![key] = null;
      expect(
        buildPurchaseOrderDiagnostics(order(item), facts()).lineSubtotals[0]
          .subtotal,
      ).toBeNull();
    },
  );
  it('uses line indexes, not UUIDs; ordinal sorting handles indexes above 9', () => {
    const body = order();
    body.lines = Array.from({ length: 12 }, (_, index) => ({
      ...line(),
      lineId: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      productId: null,
    }));
    const result = buildPurchaseOrderDiagnostics(body, facts());
    const paths = result.issues.map((issue) => issue.path);
    expect(paths).toEqual([...paths].sort());
    expect(paths[1]).toBe('/lines/1/productId');
    expect(paths[2]).toBe('/lines/10/productId');
    expect(result.lineSubtotals).toHaveLength(12);
    expect(result.lineSubtotals.every((item) => item.subtotal === null)).toBe(
      true,
    );
  });
});
