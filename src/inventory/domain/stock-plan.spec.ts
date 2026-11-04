import { StockPlan } from './stock-plan';
import {
  InsufficientStockError,
  StockBucketNotFoundError,
  StockNotTrackedError,
  StockVersionConflictError,
} from './stock-journal.errors';
import type { ProductStockState } from './stock-journal.types';

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const TODAY = '2026-11-04';

function product(over: Partial<ProductStockState> = {}): ProductStockState {
  return {
    id: 'p1',
    name: 'Paracetamol',
    quantity: 0,
    stockVersion: 3,
    useStock: true,
    hasVariants: false,
    lots: [],
    variants: [],
    ...over,
  };
}

const lotsProduct = () =>
  product({
    quantity: 20, // untracked 5 + a:8 + b:7
    lots: [
      {
        id: 'a',
        lotNumber: 'L-A',
        quantity: 8,
        stockVersion: 1,
        expirationDate: d('2026-11-10'),
      },
      {
        id: 'b',
        lotNumber: 'L-B',
        quantity: 7,
        stockVersion: 0,
        expirationDate: d('2026-12-10'),
      },
    ],
  });

describe('StockPlan.apply', () => {
  it('moves the untracked portion and snapshots labels', () => {
    const plan = new StockPlan([lotsProduct()], TODAY);
    plan.apply({
      bucket: { kind: 'PRODUCT_UNTRACKED', productId: 'p1' },
      delta: -2,
    });
    expect(plan.movements).toEqual([
      expect.objectContaining({
        bucketKind: 'PRODUCT_UNTRACKED',
        productName: 'Paracetamol',
        delta: -2,
        balanceAfter: 3,
        productBalanceAfter: 18,
        bucketVersionAfter: 4,
      }),
    ]);
  });

  it('moves the lot and the product total, leaving the untracked version alone', () => {
    const plan = new StockPlan([lotsProduct()], TODAY);
    plan.apply({
      bucket: { kind: 'LOT', productId: 'p1', lotId: 'a' },
      delta: 4,
    });
    expect(plan.movements[0]).toEqual(
      expect.objectContaining({
        bucketKind: 'LOT',
        lotId: 'a',
        lotNumber: 'L-A',
        balanceAfter: 12,
        productBalanceAfter: 24,
        bucketVersionAfter: 2,
      }),
    );
    expect(plan.touchedProducts.get('p1')).toEqual({
      quantity: 24,
      bumpVersion: false,
    });
  });

  it('rejects a negative lot, untracked portion or variant (S4)', () => {
    const plan = new StockPlan([lotsProduct()], TODAY);
    expect(() =>
      plan.apply({
        bucket: { kind: 'LOT', productId: 'p1', lotId: 'b' },
        delta: -8,
      }),
    ).toThrow(InsufficientStockError);
    expect(() =>
      plan.apply({
        bucket: { kind: 'PRODUCT_UNTRACKED', productId: 'p1' },
        delta: -6,
      }),
    ).toThrow(InsufficientStockError);
    const variants = new StockPlan(
      [
        product({
          hasVariants: true,
          variants: [{ id: 'v1', name: 'M', quantity: 2, stockVersion: 0 }],
        }),
      ],
      TODAY,
    );
    expect(() =>
      variants.apply({
        bucket: { kind: 'VARIANT', productId: 'p1', variantId: 'v1' },
        delta: -3,
      }),
    ).toThrow(InsufficientStockError);
    expect(plan.movements).toEqual([]);
  });

  it('reports variant balances against the sum of the variants', () => {
    const plan = new StockPlan(
      [
        product({
          hasVariants: true,
          variants: [
            { id: 'v1', name: 'S', quantity: 2, stockVersion: 0 },
            { id: 'v2', name: 'M', quantity: 5, stockVersion: 7 },
          ],
        }),
      ],
      TODAY,
    );
    plan.apply({
      bucket: { kind: 'VARIANT', productId: 'p1', variantId: 'v2' },
      delta: -1,
    });
    expect(plan.movements[0]).toEqual(
      expect.objectContaining({
        variantLabel: 'M',
        balanceAfter: 4,
        productBalanceAfter: 6,
        bucketVersionAfter: 8,
      }),
    );
  });

  it('enforces the bucket CAS token', () => {
    const plan = new StockPlan([lotsProduct()], TODAY);
    expect(() =>
      plan.apply({
        bucket: { kind: 'LOT', productId: 'p1', lotId: 'a' },
        delta: 1,
        expectedVersion: 0,
      }),
    ).toThrow(StockVersionConflictError);
    expect(() =>
      plan.apply({
        bucket: { kind: 'LOT', productId: 'p1', lotId: 'a' },
        delta: 1,
        expectedVersion: 1,
      }),
    ).not.toThrow();
  });

  it('fails on unknown buckets and handles products without stock', () => {
    const plan = new StockPlan([product({ useStock: false })], TODAY);
    expect(() =>
      plan.apply({
        bucket: { kind: 'LOT', productId: 'p1', lotId: 'zz' },
        delta: 1,
      }),
    ).toThrow(StockBucketNotFoundError);
    expect(() =>
      plan.apply({
        bucket: { kind: 'PRODUCT_UNTRACKED', productId: 'nope' },
        delta: 1,
      }),
    ).toThrow(StockBucketNotFoundError);
    expect(() =>
      plan.apply({
        bucket: { kind: 'PRODUCT_UNTRACKED', productId: 'p1' },
        delta: 1,
      }),
    ).toThrow(StockNotTrackedError);
    plan.apply({
      bucket: { kind: 'PRODUCT_UNTRACKED', productId: 'p1' },
      delta: 1,
      skipIfNotStocked: true,
    });
    expect(plan.movements).toEqual([]);
  });

  it('chains balances when one bucket changes twice in a call', () => {
    const plan = new StockPlan([lotsProduct()], TODAY);
    const bucket = { kind: 'LOT', productId: 'p1', lotId: 'a' } as const;
    plan.apply({ bucket, delta: -3 });
    plan.apply({ bucket, delta: -5 });
    expect(plan.movements.map((m) => m.balanceAfter)).toEqual([5, 0]);
    expect(plan.movements.map((m) => m.bucketVersionAfter)).toEqual([2, 2]);
    expect(() => plan.apply({ bucket, delta: -1 })).toThrow(
      InsufficientStockError,
    );
  });
});

describe('StockPlan.charge (S6 sale lines)', () => {
  it('splits a line FEFO across lots and the untracked remainder, one row per bucket', () => {
    const plan = new StockPlan([lotsProduct()], TODAY);
    plan.charge({ productId: 'p1', quantity: 18 });
    expect(plan.movements.map((m) => [m.bucketKind, m.lotId, m.delta])).toEqual(
      [
        ['LOT', 'a', -8],
        ['LOT', 'b', -7],
        ['PRODUCT_UNTRACKED', null, -3],
      ],
    );
    expect(plan.movements.at(-1)?.productBalanceAfter).toBe(2);
  });

  it('does not sell expired lot stock even though it counts in the product total', () => {
    const p = lotsProduct();
    p.lots[0].expirationDate = d('2026-11-03');
    const plan = new StockPlan([p], TODAY);
    expect(() => plan.charge({ productId: 'p1', quantity: 13 })).toThrow(
      InsufficientStockError,
    );
    plan.charge({ productId: 'p1', quantity: 12 }); // lot b 7 + untracked 5
    expect(plan.movements.map((m) => m.lotId)).toEqual(['b', null]);
  });

  it('accounts for earlier lines of the same product', () => {
    const plan = new StockPlan([lotsProduct()], TODAY);
    plan.charge({ productId: 'p1', quantity: 10 });
    plan.charge({ productId: 'p1', quantity: 10 });
    expect(() => plan.charge({ productId: 'p1', quantity: 1 })).toThrow(
      InsufficientStockError,
    );
  });

  it('charges variants directly and skips products that do not track stock', () => {
    const plan = new StockPlan(
      [
        product({
          hasVariants: true,
          variants: [{ id: 'v1', name: 'S', quantity: 2, stockVersion: 0 }],
        }),
        product({ id: 'svc', useStock: false }),
      ],
      TODAY,
    );
    plan.charge({ productId: 'p1', variantId: 'v1', quantity: 2 });
    plan.charge({ productId: 'svc', quantity: 4 });
    expect(plan.movements).toHaveLength(1);
    expect(plan.movements[0]).toEqual(
      expect.objectContaining({
        bucketKind: 'VARIANT',
        delta: -2,
        balanceAfter: 0,
      }),
    );
  });
});
