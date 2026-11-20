import {
  ETA_STAGE,
  isOverdueForReestimate,
  planEtaResolution,
  planReestimate,
  receivesEtaAnswer,
  reestimateSourceRequestId,
  variantKeyOf,
} from './backorder-reestimate';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NOW = new Date('2026-11-20T12:00:00.000Z');
const PAST = new Date('2026-11-19T12:00:00.000Z');
const FUTURE = new Date('2026-11-21T12:00:00.000Z');

describe('reestimateSourceRequestId', () => {
  it('is a canonical RFC 4122 UUID the RESTOCK intake accepts', () => {
    expect(reestimateSourceRequestId('t', 'p', null, 1)).toMatch(UUID);
    expect(reestimateSourceRequestId('t', 'p', 'v', 7)).toMatch(UUID);
  });

  it('is deterministic: the same tenant + product + variant + round always gives the same identity', () => {
    expect(reestimateSourceRequestId('t', 'p', 'v', 1)).toBe(
      reestimateSourceRequestId('t', 'p', 'v', 1),
    );
  });

  it('differs per tenant, product, variant and round', () => {
    const ids = new Set([
      reestimateSourceRequestId('t1', 'p', null, 1),
      reestimateSourceRequestId('t2', 'p', null, 1),
      reestimateSourceRequestId('t1', 'p2', null, 1),
      reestimateSourceRequestId('t1', 'p', 'v', 1),
      reestimateSourceRequestId('t1', 'p', null, 2),
    ]);
    expect(ids.size).toBe(5);
  });

  it('does not collide when the variant key shifts across fields', () => {
    expect(reestimateSourceRequestId('t', 'p', 'v1', 1)).not.toBe(
      reestimateSourceRequestId('t', 'pv', '1', 1),
    );
  });
});

describe('variantKeyOf', () => {
  it('is empty for a product without variants', () => {
    expect(variantKeyOf(null)).toBe('');
    expect(variantKeyOf('v')).toBe('v');
  });
});

describe('isOverdueForReestimate (attach rule)', () => {
  const row = { status: 'WAITING', etaStage: 0, estimatedAt: PAST };

  it('asks only for WAITING, etaStage 0 and an estimatedAt in the past', () => {
    expect(isOverdueForReestimate(row, NOW)).toBe(true);
  });

  it('a future or exactly-now estimate is not overdue', () => {
    expect(isOverdueForReestimate({ ...row, estimatedAt: FUTURE }, NOW)).toBe(
      false,
    );
    expect(isOverdueForReestimate({ ...row, estimatedAt: NOW }, NOW)).toBe(
      false,
    );
  });

  it('once only: etaStage 1 (asked) and 2 (answered) never ask again', () => {
    expect(isOverdueForReestimate({ ...row, etaStage: 1 }, NOW)).toBe(false);
    expect(isOverdueForReestimate({ ...row, etaStage: 2 }, NOW)).toBe(false);
  });

  it.each(['RESERVED', 'CONFIRMED', 'EXPIRED', 'CANCELLED'])(
    'a %s backorder is never asked for',
    (status) => {
      expect(isOverdueForReestimate({ ...row, status }, NOW)).toBe(false);
    },
  );
});

describe('planReestimate (one decision per product)', () => {
  it('attaches to the pending decision instead of creating another', () => {
    expect(
      planReestimate({ pendingDecisionId: 'd-1', decisionsCreated: 1 }),
    ).toEqual({ kind: 'attach', decisionId: 'd-1' });
  });

  it('opens round 1 when none was ever created', () => {
    expect(
      planReestimate({ pendingDecisionId: null, decisionsCreated: 0 }),
    ).toEqual({ kind: 'create', round: 1 });
  });

  it('opens the next round only when every earlier one was answered', () => {
    expect(
      planReestimate({ pendingDecisionId: null, decisionsCreated: 2 }),
    ).toEqual({ kind: 'create', round: 3 });
  });
});

describe('planEtaResolution (fan-out meaning of the staff answer)', () => {
  const resolvedAt = new Date('2026-11-20T10:00:00.000Z');

  it('PROVIDE_RESTOCK_ESTIMATE → estimatedAt = resolvedAt + restockDays', () => {
    expect(
      planEtaResolution({
        action: 'PROVIDE_RESTOCK_ESTIMATE',
        restockDays: 5,
        resolvedAt,
      }),
    ).toEqual({
      kind: 'ESTIMATE',
      restockDays: 5,
      estimatedAt: new Date('2026-11-25T10:00:00.000Z'),
    });
  });

  it('REPORT_RESTOCK_ESTIMATE_UNAVAILABLE → unavailable', () => {
    expect(
      planEtaResolution({
        action: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
        restockDays: null,
        resolvedAt,
      }),
    ).toEqual({ kind: 'UNAVAILABLE' });
  });

  it('is not a RESTOCK answer: an EXPIRATION action, a provide without days or without a time', () => {
    expect(
      planEtaResolution({
        action: 'PROVIDE_EXPIRATION_TEXT',
        restockDays: null,
        resolvedAt,
      }),
    ).toBeNull();
    expect(
      planEtaResolution({
        action: 'PROVIDE_RESTOCK_ESTIMATE',
        restockDays: null,
        resolvedAt,
      }),
    ).toBeNull();
    expect(
      planEtaResolution({
        action: 'PROVIDE_RESTOCK_ESTIMATE',
        restockDays: 3,
        resolvedAt: null,
      }),
    ).toBeNull();
    expect(
      planEtaResolution({ action: null, restockDays: null, resolvedAt }),
    ).toBeNull();
  });
});

describe('receivesEtaAnswer (fan-out target rule)', () => {
  const row = {
    status: 'WAITING',
    etaStage: ETA_STAGE.REQUESTED,
    reestimateDecisionId: 'd-1',
  };

  it('a WAITING backorder attached to the decision (etaStage 1) receives it', () => {
    expect(receivesEtaAnswer(row, 'd-1')).toBe(true);
  });

  it('another decision, etaStage 0 or etaStage 2 does not (once only)', () => {
    expect(receivesEtaAnswer(row, 'd-2')).toBe(false);
    expect(receivesEtaAnswer({ ...row, etaStage: 0 }, 'd-1')).toBe(false);
    expect(receivesEtaAnswer({ ...row, etaStage: 2 }, 'd-1')).toBe(false);
  });

  it.each(['RESERVED', 'CONFIRMED', 'EXPIRED', 'CANCELLED'])(
    'a backorder that became %s meanwhile is skipped',
    (status) => {
      expect(receivesEtaAnswer({ ...row, status }, 'd-1')).toBe(false);
    },
  );
});
