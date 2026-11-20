import { InsufficientStockError } from './stock-journal.errors';
import type { ProductStockState } from './stock-journal.types';
import { StockPlan } from './stock-plan';

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const TODAY = '2026-11-04';

function product(over: Partial<ProductStockState> = {}): ProductStockState {
  return {
    id: 'p1',
    name: 'Croquetas',
    quantity: 0,
    stockVersion: 0,
    useStock: true,
    hasVariants: false,
    lots: [],
    variants: [],
    ...over,
  };
}

/** untracked 5 + lot a 8 (soon) + lot b 7 (later) + lot x 50 (expired) = 70. */
const lotsProduct = () =>
  product({
    quantity: 70,
    lots: [
      {
        id: 'a',
        lotNumber: 'A',
        quantity: 8,
        stockVersion: 0,
        expirationDate: d('2026-11-10'),
      },
      {
        id: 'b',
        lotNumber: 'B',
        quantity: 7,
        stockVersion: 0,
        expirationDate: d('2026-12-10'),
      },
      {
        id: 'x',
        lotNumber: 'X',
        quantity: 50,
        stockVersion: 0,
        expirationDate: d('2026-11-01'),
      },
    ],
  });

describe('StockPlan.sellable (what a backorder reservation may take)', () => {
  it('counts untracked + non-expired lots and ignores expired lots', () => {
    expect(new StockPlan([lotsProduct()], TODAY).sellable('p1', null)).toBe(20);
  });

  it('reads a variant from its own quantity, never below 0', () => {
    const plan = new StockPlan(
      [
        product({
          hasVariants: true,
          variants: [
            { id: 'v1', name: 'Grande', quantity: 4, stockVersion: 0 },
            { id: 'v2', name: 'Chica', quantity: 0, stockVersion: 0 },
          ],
        }),
      ],
      TODAY,
    );
    expect(plan.sellable('p1', 'v1')).toBe(4);
    expect(plan.sellable('p1', 'v2')).toBe(0);
  });

  it('is null when the product does not track stock and 0 for unknown buckets', () => {
    const plan = new StockPlan([product({ useStock: false })], TODAY);
    expect(plan.sellable('p1', null)).toBeNull();
    expect(plan.sellable('ghost', null)).toBe(0);
    expect(new StockPlan([product()], TODAY).sellable('p1', 'nope')).toBe(0);
  });

  it('a reservation (charge) takes FEFO over NON-expired lots, then untracked, never the expired lot', () => {
    const plan = new StockPlan([lotsProduct()], TODAY);
    plan.charge({ productId: 'p1', quantity: 18 });
    expect(plan.movements.map((m) => [m.lotId, m.delta])).toEqual([
      ['a', -8],
      ['b', -7],
      [null, -3],
    ]);
    expect(plan.sellable('p1', null)).toBe(2);
    expect(plan.touchedLots.has('x')).toBe(false);
  });

  it('cannot reserve more than the sellable units even when expired lots hold plenty', () => {
    const plan = new StockPlan([lotsProduct()], TODAY);
    expect(() => plan.charge({ productId: 'p1', quantity: 21 })).toThrow(
      InsufficientStockError,
    );
    expect(plan.movements).toHaveLength(0);
  });

  it('exposes lot expiry for the swap primitive', () => {
    const plan = new StockPlan([lotsProduct()], TODAY);
    expect(plan.isLotExpired('p1', 'x')).toBe(true);
    expect(plan.isLotExpired('p1', 'a')).toBe(false);
    expect(plan.isLotExpired('p1', 'missing')).toBe(false);
  });
});
