import { buildStockSnapshot, type StockRows } from './inventory-views';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const base: StockRows = {
  product: {
    id: 'p',
    name: 'Leche',
    type: 'PRODUCT',
    useStock: true,
    hasVariants: false,
    quantity: 70,
    stockVersion: 4,
  },
  lots: [
    {
      id: 'b',
      lotNumber: 'B',
      quantity: 7,
      stockVersion: 1,
      expirationDate: day('2026-12-10'),
    },
    {
      id: 'x',
      lotNumber: 'X',
      quantity: 50,
      stockVersion: 2,
      expirationDate: day('2026-11-01'),
    },
    {
      id: 'a',
      lotNumber: 'A',
      quantity: 8,
      stockVersion: 0,
      expirationDate: day('2026-11-04'),
    },
  ],
  variants: [],
};

describe('stock snapshot projection', () => {
  it('splits untracked from lots, flags expired lots and excludes them from sellable', () => {
    const snapshot = buildStockSnapshot(base, '2026-11-04');
    expect(snapshot.product).toEqual({
      id: 'p',
      name: 'Leche',
      useStock: true,
      quantity: 70,
      untracked: { quantity: 5, version: 4 },
      sellable: 20,
    });
    expect(
      snapshot.lots.map((l) => [l.id, l.expired, l.expirationDate, l.version]),
    ).toEqual([
      ['x', true, '2026-11-01', 2],
      ['a', false, '2026-11-04', 0],
      ['b', false, '2026-12-10', 1],
    ]);
    expect(snapshot.variants).toEqual([]);
  });

  it('reports a variant product total as the variants sum with no untracked portion', () => {
    const snapshot = buildStockSnapshot(
      {
        ...base,
        product: { ...base.product, hasVariants: true, quantity: 0 },
        lots: [],
        variants: [
          { id: 'v1', name: 'Rojo', quantity: 3, stockVersion: 1 },
          { id: 'v2', name: 'Azul', quantity: 4, stockVersion: 0 },
        ],
      },
      '2026-11-04',
    );
    expect(snapshot.product.quantity).toBe(7);
    expect(snapshot.product.sellable).toBe(7);
    expect(snapshot.product.untracked).toEqual({ quantity: 0, version: 4 });
    expect(snapshot.variants).toEqual([
      { id: 'v1', label: 'Rojo', quantity: 3, version: 1 },
      { id: 'v2', label: 'Azul', quantity: 4, version: 0 },
    ]);
  });

  it('has no sellable figure when the product does not track stock', () => {
    expect(
      buildStockSnapshot(
        { ...base, product: { ...base.product, useStock: false } },
        '2026-11-04',
      ).product.sellable,
    ).toBeNull();
    expect(
      buildStockSnapshot(
        { ...base, product: { ...base.product, type: 'SERVICE' } },
        '2026-11-04',
      ).product.sellable,
    ).toBeNull();
  });
});
