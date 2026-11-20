import {
  reservationWindow,
  unitPriceFromLine,
  walkQueue,
  type QueuedBackorder,
} from './backorder-allocation';

const bo = (
  id: string,
  quantity: number,
  referencePriceCents = 1000,
): QueuedBackorder => ({
  id,
  quantity,
  customerId: `c-${id}`,
  referencePriceCents,
});

/** priceOf that prices every backorder at `cents` and records the calls. */
const priced = (cents: number | Record<string, number | null>) => {
  const calls: string[] = [];
  return {
    calls,
    priceOf: (b: QueuedBackorder) => {
      calls.push(b.id);
      return Promise.resolve(typeof cents === 'number' ? cents : cents[b.id]);
    },
  };
};

describe('reservationWindow (owner D3: 24 h from the moment of reservation)', () => {
  it('reservedUntil = +24 h and reminderAt = reservedUntil - 3 h', () => {
    const now = new Date('2026-11-20T15:30:00.000Z');
    expect(reservationWindow(now)).toEqual({
      reservedAt: now,
      reservedUntil: new Date('2026-11-21T15:30:00.000Z'),
      reminderAt: new Date('2026-11-21T12:30:00.000Z'),
    });
  });
});

describe('unitPriceFromLine (the customer never pays more than the counter line)', () => {
  it('divides an exact line total', () => {
    expect(unitPriceFromLine(219800, 2)).toBe(109900);
  });
  it('rounds DOWN when a promotion leaves a non-integer unit price', () => {
    // 3 units, buy-2-get-1-half-off: 2999 / 3 = 999.67 → 999; 999 * 3 <= 2999
    expect(unitPriceFromLine(2999, 3)).toBe(999);
  });
  it('never goes below zero', () => {
    expect(unitPriceFromLine(0, 4)).toBe(0);
  });
});

describe('walkQueue (owner Q1: «Apartarlas a los siguientes que sí alcanzan»)', () => {
  it('reserves in queue order while the whole quantity fits', async () => {
    const { priceOf } = priced(900);
    const walk = await walkQueue({
      queue: [bo('a', 2), bo('b', 3), bo('c', 1)],
      sellable: 6,
      priceOf,
    });
    expect(walk.reservations.map((r) => r.backorder.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(walk.remaining).toBe(0);
    expect(walk.passedOverIds).toEqual([]);
  });

  it('never partially reserves: a head that does not fit keeps its place and is passed over by those behind that do', async () => {
    const { priceOf, calls } = priced(900);
    const walk = await walkQueue({
      queue: [bo('head', 5), bo('b', 2), bo('c', 1)],
      sellable: 3,
      priceOf,
    });
    expect(walk.reservations.map((r) => r.backorder.id)).toEqual(['b', 'c']);
    expect(walk.passedOverIds).toEqual(['head']);
    expect(walk.remaining).toBe(0);
    // The head was never priced: it was not reserved.
    expect(calls).toEqual(['b', 'c']);
  });

  it('walks the WHOLE queue, not just until the first miss', async () => {
    const { priceOf } = priced(900);
    const walk = await walkQueue({
      queue: [bo('a', 4), bo('b', 4), bo('c', 1), bo('d', 2)],
      sellable: 3,
      priceOf,
    });
    expect(walk.reservations.map((r) => r.backorder.id)).toEqual(['c', 'd']);
    expect(walk.passedOverIds).toEqual(['a', 'b']);
  });

  it('counts a pass-over at most once per pass, however many are reserved behind', async () => {
    const { priceOf } = priced(900);
    const walk = await walkQueue({
      queue: [bo('head', 9), bo('b', 1), bo('c', 1), bo('d', 1)],
      sellable: 3,
      priceOf,
    });
    expect(walk.passedOverIds).toEqual(['head']);
  });

  it('does not flag a backorder when nobody behind it was reserved', async () => {
    const { priceOf } = priced(900);
    const walk = await walkQueue({
      queue: [bo('a', 1), bo('head', 5), bo('c', 5)],
      sellable: 2,
      priceOf,
    });
    expect(walk.reservations.map((r) => r.backorder.id)).toEqual(['a']);
    // head and c did not fit but nothing BEHIND them was reserved.
    expect(walk.passedOverIds).toEqual([]);
  });

  it('flags only the backorders that have a reserved one behind them', async () => {
    const { priceOf } = priced(900);
    const walk = await walkQueue({
      queue: [bo('a', 9), bo('b', 1), bo('c', 9)],
      sellable: 1,
      priceOf,
    });
    expect(walk.reservations.map((r) => r.backorder.id)).toEqual(['b']);
    expect(walk.passedOverIds).toEqual(['a']);
  });

  it('reserves nothing and flags nothing with no stock', async () => {
    const { priceOf, calls } = priced(900);
    const walk = await walkQueue({
      queue: [bo('a', 1)],
      sellable: 0,
      priceOf,
    });
    expect(walk).toEqual({
      reservations: [],
      passedOverIds: [],
      unpricedIds: [],
      remaining: 0,
    });
    expect(calls).toEqual([]);
  });

  it('final = min(reference, current): a cheaper current price wins (promo, Q2)', async () => {
    const walk = await walkQueue({
      queue: [bo('a', 1, 1000)],
      sellable: 1,
      priceOf: priced(800).priceOf,
    });
    expect(walk.reservations[0]).toMatchObject({
      currentPriceCents: 800,
      finalPriceCents: 800,
    });
  });

  it('final = min(reference, current): a higher current price never raises it (D1)', async () => {
    const walk = await walkQueue({
      queue: [bo('a', 1, 1000)],
      sellable: 1,
      priceOf: priced(1200).priceOf,
    });
    expect(walk.reservations[0]).toMatchObject({
      currentPriceCents: 1200,
      finalPriceCents: 1000,
    });
  });

  it('a backorder whose price cannot be computed stays WAITING, keeps the stock for the next and is not a pass-over', async () => {
    const { priceOf } = priced({ a: null, b: 700 });
    const walk = await walkQueue({
      queue: [bo('a', 2), bo('b', 2)],
      sellable: 2,
      priceOf,
    });
    expect(walk.unpricedIds).toEqual(['a']);
    expect(walk.reservations.map((r) => r.backorder.id)).toEqual(['b']);
    expect(walk.passedOverIds).toEqual([]);
    expect(walk.remaining).toBe(0);
  });
});
