/**
 * The unit seams of the backorder sweep store (restock-backorder T2b): a
 * candidate that throws is counted, logged without customer data and backed off
 * (60 s, per process) so it never sits at the head of every tick; the candidate
 * reads are unaffected by the other phases' backoff. The behaviour under the
 * real locks is proven by `backorder-sweep.integration.spec.ts`.
 */
import { Logger } from '@nestjs/common';
import {
  BACKORDER_FAILURE_BACKOFF_MS,
  BackorderSweepStore,
} from './backorder-sweep.store';

const NOW = new Date('2026-11-21T12:00:00.000Z');

class TestStore extends BackorderSweepStore {
  readonly excludedSeen: string[][] = [];
  candidates = [
    {
      id: 'b1',
      tenantId: 't1',
      productId: 'p1',
      reservedUntil: new Date(NOW.getTime() - 1000),
    },
  ];

  protected override readDueCandidates(
    _now: Date,
    _after: unknown,
    excluded: string[],
  ) {
    this.excludedSeen.push([...excluded]);
    return Promise.resolve(
      this.candidates.filter((candidate) => !excluded.includes(candidate.id)),
    );
  }
}

function setup(runWithTenant: jest.Mock) {
  const store = new TestStore(
    {} as never,
    {} as never,
    { runWithTenant } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return store;
}

describe('BackorderSweepStore failure backoff', () => {
  let error: jest.SpyInstance;
  beforeEach(() => {
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => error.mockRestore());

  it('counts a failed candidate, logs ids only and does not retry it within the backoff', async () => {
    const runWithTenant = jest.fn().mockRejectedValue(new Error('boom'));
    const store = setup(runWithTenant);

    const first = await store.runDueBatch(NOW, null);
    expect(first).toMatchObject({ candidates: 1, failed: 1 });
    expect(error).toHaveBeenCalledTimes(1);
    const logged = String((error.mock.calls as unknown[][])[0][0]);
    expect(logged).toContain('b1');
    expect(logged).toContain('t1');

    const second = await store.runDueBatch(
      new Date(NOW.getTime() + 1000),
      null,
    );
    expect(second.candidates).toBe(0);
    expect(store.excludedSeen[1]).toEqual(['b1']);
    expect(runWithTenant).toHaveBeenCalledTimes(1);

    // Retried once the backoff elapsed.
    const third = await store.runDueBatch(
      new Date(NOW.getTime() + BACKORDER_FAILURE_BACKOFF_MS + 1),
      null,
    );
    expect(third.candidates).toBe(1);
    expect(runWithTenant).toHaveBeenCalledTimes(2);
  });

  it('a candidate that works is counted by its outcome and keyset-cursored', async () => {
    const runWithTenant = jest.fn().mockResolvedValue('expired');
    const store = setup(runWithTenant);
    const result = await store.runDueBatch(NOW, null);
    expect(result).toMatchObject({ candidates: 1, expired: 1, failed: 0 });
    expect(result.last).toEqual({
      reservedUntil: store.candidates[0].reservedUntil,
      id: 'b1',
    });
    expect(runWithTenant).toHaveBeenCalledWith('t1', expect.any(Function));
  });
});

describe('BackorderSweepStore overdue-ETA phase (T4)', () => {
  const candidate = {
    tenantId: 't1',
    productId: 'p1',
    variantId: null,
    variantKey: '',
  };

  class EtaStore extends BackorderSweepStore {
    readonly excludedSeen: string[][] = [];
    protected override readEtaCandidates(
      _now: Date,
      _after: unknown,
      excluded: string[],
    ) {
      this.excludedSeen.push([...excluded]);
      return Promise.resolve(
        excluded.includes('t1:p1:') ? [] : [{ ...candidate }],
      );
    }
  }

  function build(requestForGroup: jest.Mock) {
    const runInTransaction = jest.fn((work: () => Promise<unknown>) => work());
    const runWithTenant = jest.fn(
      (_tenant: string, work: () => Promise<unknown>) => work(),
    );
    const store = new EtaStore(
      {} as never,
      { runInTransaction } as never,
      { runWithTenant } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { requestForGroup } as never,
    );
    return { store, runInTransaction, runWithTenant };
  }

  let error: jest.SpyInstance;
  beforeEach(() => {
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => error.mockRestore());

  it('runs the group OUTSIDE a transaction (the RESTOCK intake refuses to nest), in its tenant', async () => {
    const requestForGroup = jest
      .fn()
      .mockResolvedValue({ created: true, attached: 5 });
    const { store, runInTransaction, runWithTenant } = build(requestForGroup);

    const result = await store.runReestimateBatch(NOW, null);

    expect(runWithTenant).toHaveBeenCalledWith('t1', expect.any(Function));
    expect(runInTransaction).not.toHaveBeenCalled();
    expect(requestForGroup).toHaveBeenCalledWith(
      { tenantId: 't1', productId: 'p1', variantId: null },
      NOW,
    );
    expect(result).toMatchObject({
      candidates: 1,
      reestimates: 1,
      attached: 5,
      stale: 0,
      failed: 0,
    });
    expect(result.last).toEqual({
      tenantId: 't1',
      productId: 'p1',
      variantKey: '',
    });
  });

  it('a group that joins a pending decision creates nothing and counts only the backorders attached', async () => {
    const { store } = build(
      jest.fn().mockResolvedValue({ created: false, attached: 2 }),
    );
    expect(await store.runReestimateBatch(NOW, null)).toMatchObject({
      reestimates: 0,
      attached: 2,
    });
  });

  it('a group another tick already handled is stale', async () => {
    const { store } = build(
      jest.fn().mockResolvedValue({ created: false, attached: 0 }),
    );
    expect(await store.runReestimateBatch(NOW, null)).toMatchObject({
      candidates: 1,
      stale: 1,
      reestimates: 0,
      attached: 0,
    });
  });

  it('a failing group is counted, logged without customer data and backed off by its group key', async () => {
    const requestForGroup = jest.fn().mockRejectedValue(new Error('boom'));
    const { store } = build(requestForGroup);

    expect(await store.runReestimateBatch(NOW, null)).toMatchObject({
      candidates: 1,
      failed: 1,
    });
    const logged = String((error.mock.calls as unknown[][])[0][0]);
    expect(logged).toContain('t1');
    expect(logged).toContain('p1');

    const second = await store.runReestimateBatch(
      new Date(NOW.getTime() + 1000),
      null,
    );
    expect(second.candidates).toBe(0);
    expect(store.excludedSeen[1]).toEqual(['t1:p1:']);
    expect(requestForGroup).toHaveBeenCalledTimes(1);
  });
});
