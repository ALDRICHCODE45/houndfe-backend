import type { OrderInput, OrderLine } from './po-contract';
import { computePurchaseOrderReferenceToken } from './po-reference-token';
import type {
  PurchaseOrderLineReferenceFacts,
  PurchaseOrderReferenceFacts,
} from './po-validation';

const supplierId = '10000000-0000-4000-8000-000000000001';
const lineA = '20000000-0000-4000-8000-00000000000a';
const lineB = '20000000-0000-4000-8000-00000000000b';
const productA = '30000000-0000-4000-8000-00000000000a';
const productB = '30000000-0000-4000-8000-00000000000b';
const variantA = '40000000-0000-4000-8000-00000000000a';

const line = (lineId: string, productId: string | null): OrderLine => ({
  lineId,
  productId,
  variantId: null,
  orderedQuantity: '2',
  informedUnitCost: {
    amount: '1.5',
    currency: 'MXN',
    unit: 'CAJA',
    taxBasis: 'EXCLUDES_TAX',
  },
});
const order = (lines: OrderLine[] = [line(lineA, productA)]): OrderInput => ({
  supplierId,
  note: null,
  location: { detail: null },
  lines,
});
const product = (
  overrides: Partial<{
    type: 'PRODUCT' | 'SERVICE';
    unit: 'CAJA' | 'KILOGRAMO';
    hasVariants: boolean;
  }> = {},
): PurchaseOrderLineReferenceFacts => ({
  product: { type: 'PRODUCT', unit: 'CAJA', hasVariants: false, ...overrides },
  variant: 'missing',
});
const facts = (
  lines: Record<string, PurchaseOrderLineReferenceFacts> = {
    [lineA]: product(),
  },
  supplier: PurchaseOrderReferenceFacts['supplier'] = 'ACTIVE',
): PurchaseOrderReferenceFacts => ({ supplier, lines });
const token = (o = order(), f = facts()) =>
  computePurchaseOrderReferenceToken(o, f);
const withVariant = (belongs = true) => {
  const item = { ...line(lineA, productA), variantId: variantA };
  return {
    order: order([item]),
    facts: facts({
      [lineA]: {
        product: { type: 'PRODUCT', unit: 'CAJA', hasVariants: true },
        variant: { belongsToProduct: belongs },
      },
    }),
  };
};

describe('purchase-order reference token', () => {
  it('is an opaque versioned base64url string, deterministic for the same observed set', () => {
    const first = token();
    expect(first).toMatch(/^prt1\.[A-Za-z0-9_-]{43}$/);
    expect(token()).toBe(first);
    expect(token(order(), facts())).toBe(first);
  });
  it('ignores quantities, costs, notes, location, labels and archive status', () => {
    const base = token();
    const changed = order();
    changed.note = 'other';
    changed.location.detail = 'shelf 9';
    changed.lines[0].orderedQuantity = '99';
    changed.lines[0].informedUnitCost = {
      amount: '777',
      currency: 'MXN',
      unit: 'CAJA',
      taxBasis: 'INCLUDES_TAX',
    };
    expect(token(changed)).toBe(base);
    // Missing quantity/cost are completeness issues for confirm, not reference facts.
    const incomplete = order();
    incomplete.lines[0].orderedQuantity = null;
    incomplete.lines[0].informedUnitCost = null;
    expect(token(incomplete)).toBe(base);
    expect(token(order(), facts(undefined, 'ARCHIVED'))).toBe(base);
  });
  it('treats lines as a set keyed by lineId', () => {
    const both = {
      [lineA]: product(),
      [lineB]: product({ unit: 'CAJA' }),
    };
    const forward = order([line(lineA, productA), line(lineB, productB)]);
    const reversed = order([line(lineB, productB), line(lineA, productA)]);
    expect(token(forward, facts(both))).toBe(token(reversed, facts(both)));
  });
  it('changes when any observed identity, membership or configuration changes', () => {
    const base = token();
    const seen = new Set([base]);
    const differs = (value: string | null) => {
      expect(value).not.toBeNull();
      expect(seen.has(value)).toBe(false);
      seen.add(value);
    };
    differs(token({ ...order(), supplierId: lineB }));
    differs(
      token(order([line(lineB, productA)]), facts({ [lineB]: product() })),
    );
    differs(token(order([line(lineA, productB)])));
    differs(
      token(
        order([line(lineA, productA), line(lineB, productB)]),
        facts({
          [lineA]: product(),
          [lineB]: product(),
        }),
      ),
    );
    const kilo = order([
      {
        ...line(lineA, productA),
        informedUnitCost: null,
      },
    ]);
    differs(token(kilo, facts({ [lineA]: product({ unit: 'KILOGRAMO' }) })));
    const variant = withVariant();
    differs(computePurchaseOrderReferenceToken(variant.order, variant.facts));
    const otherVariant = withVariant();
    otherVariant.order.lines[0].variantId = lineB;
    differs(
      computePurchaseOrderReferenceToken(
        otherVariant.order,
        otherVariant.facts,
      ),
    );
  });
  it('is null when the reference set is incomplete or invalid', () => {
    expect(token({ ...order(), supplierId: null })).toBeNull();
    expect(token(order(), facts(undefined, 'missing'))).toBeNull();
    expect(token(order([]), facts({}))).toBeNull();
    expect(token(order([line(lineA, null)]))).toBeNull();
    expect(
      token(order(), facts({ [lineA]: { ...product(), product: 'missing' } })),
    ).toBeNull();
    expect(token(order(), facts({}))).toBeNull();
    expect(
      token(order(), facts({ [lineA]: product({ type: 'SERVICE' }) })),
    ).toBeNull();
    // Product has variants but none selected.
    expect(
      token(order(), facts({ [lineA]: product({ hasVariants: true }) })),
    ).toBeNull();
    const missingVariant = withVariant();
    expect(
      computePurchaseOrderReferenceToken(
        missingVariant.order,
        facts({
          [lineA]: {
            product: { type: 'PRODUCT', unit: 'CAJA', hasVariants: true },
            variant: 'missing',
          },
        }),
      ),
    ).toBeNull();
    const wrongParent = withVariant(false);
    expect(
      computePurchaseOrderReferenceToken(wrongParent.order, wrongParent.facts),
    ).toBeNull();
    // Variant selected for a product that has no variants.
    expect(
      computePurchaseOrderReferenceToken(
        withVariant().order,
        facts({
          [lineA]: {
            product: { type: 'PRODUCT', unit: 'CAJA', hasVariants: false },
            variant: { belongsToProduct: true },
          },
        }),
      ),
    ).toBeNull();
    // Declared cost unit differs from the live product unit.
    expect(
      token(order(), facts({ [lineA]: product({ unit: 'KILOGRAMO' }) })),
    ).toBeNull();
  });
  it('one invalid line nulls the token even when another line is valid', () => {
    expect(
      token(
        order([line(lineA, productA), line(lineB, null)]),
        facts({ [lineA]: product(), [lineB]: product() }),
      ),
    ).toBeNull();
  });
});
