/**
 * The unit rules of the overdue-ETA re-estimate (restock-backorder T4): one
 * decision per product (create vs join), the deterministic identity, the
 * server-created decision being staff-only, the retry when a round was answered
 * under a slow tick, and the fan-out of the staff answer (who receives it, what
 * is written, which feed item). The behaviour under real locks and concurrency
 * is proven by `backorder-reestimate.integration.spec.ts`.
 */
import { RestockIntakeError } from '../../human-decisions/domain/restock-intake.repository';
import type { RestockResolutionRegistry } from '../../human-decisions/infrastructure/restock-resolution.registry';
import {
  REESTIMATE_SYSTEM_CREDENTIAL_ID,
  reestimateSourceRequestId,
} from '../domain/backorder-reestimate';
import {
  enqueueBackorderEtaUnavailable,
  enqueueBackorderEtaUpdated,
} from './backorder-feed-writes';
import {
  BackorderReestimateService,
  snapshotProductName,
  snapshotSku,
} from './backorder-reestimate.service';

jest.mock('./backorder-feed-writes', () => ({
  enqueueBackorderEtaUpdated: jest.fn().mockResolvedValue(true),
  enqueueBackorderEtaUnavailable: jest.fn().mockResolvedValue(true),
}));

const NOW = new Date('2026-11-20T12:00:00.000Z');
const GROUP = { tenantId: 't-1', productId: 'p-1', variantId: null };

interface Db {
  $queryRaw: jest.Mock;
  backorder: { updateMany: jest.Mock };
  product: { findFirst: jest.Mock };
  variant: { findFirst: jest.Mock };
  humanDecision: { findFirst: jest.Mock };
}

function build() {
  const db: Db = {
    $queryRaw: jest.fn(),
    backorder: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    product: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ name: 'Croquetas', sku: 'SKU-1' }),
    },
    variant: { findFirst: jest.fn().mockResolvedValue({ sku: 'VAR-1' }) },
    humanDecision: { findFirst: jest.fn() },
  };
  const tenantPrisma = {
    getClient: jest.fn(() => db),
    runInTransaction: jest.fn((work: () => Promise<unknown>) => work()),
  };
  const intake = { submit: jest.fn() };
  const registry = { register: jest.fn() };
  const service = new BackorderReestimateService(
    tenantPrisma as never,
    intake as never,
    registry as unknown as RestockResolutionRegistry,
  );
  return { service, db, tenantPrisma, intake, registry };
}

const state = (pending: string | null, created: number) => [
  { pendingDecisionId: pending, decisionsCreated: created },
];
const created = (id: string, status: 'PENDING' | 'RESOLVED' = 'PENDING') => ({
  status: 'created' as const,
  request: { id, status },
});

describe('BackorderReestimateService.requestForGroup', () => {
  beforeEach(() => jest.clearAllMocks());

  it('registers itself as the RESTOCK resolution listener at construction (no lifecycle hook)', () => {
    const { service, registry } = build();
    expect(registry.register).toHaveBeenCalledWith(service);
  });

  it('opens round 1 server-side when no decision exists: deterministic identity, system credential, no quantity snapshot, staff-only', async () => {
    const { service, db, intake } = build();
    db.$queryRaw
      .mockResolvedValueOnce(state(null, 0)) // the state snapshot
      .mockResolvedValueOnce([{ status: 'PENDING' }]) // decision FOR SHARE
      .mockResolvedValueOnce([{ id: 'b-1' }, { id: 'b-2' }]); // overdue rows
    db.backorder.updateMany.mockResolvedValue({ count: 2 });
    intake.submit.mockResolvedValue(created('d-1'));

    const result = await service.requestForGroup(GROUP, NOW);

    expect(intake.submit).toHaveBeenCalledTimes(1);
    expect(intake.submit).toHaveBeenCalledWith(
      {
        sourceRequestId: reestimateSourceRequestId('t-1', 'p-1', null, 1),
        productId: 'p-1',
        productName: 'Croquetas',
        variantId: null,
        sku: 'SKU-1',
        requestedQuantity: null,
        observedStockAtRequest: null,
        stockObservedAt: null,
        supersedesDecisionId: null,
        submittedCredentialId: REESTIMATE_SYSTEM_CREDENTIAL_ID,
      },
      { staffOnly: true },
    );
    expect(db.backorder.updateMany).toHaveBeenCalledWith({
      where: {
        tenantId: 't-1',
        id: { in: ['b-1', 'b-2'] },
        status: 'WAITING',
        etaStage: 0,
      },
      data: { etaStage: 1, reestimateDecisionId: 'd-1' },
    });
    expect(result).toEqual({ created: true, attached: 2 });
  });

  it('joins the PENDING decision instead of creating another (one re-estimate per product)', async () => {
    const { service, db, intake } = build();
    db.$queryRaw
      .mockResolvedValueOnce(state('d-pending', 1))
      .mockResolvedValueOnce([{ status: 'PENDING' }])
      .mockResolvedValueOnce([{ id: 'b-9' }]);
    db.backorder.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.requestForGroup(GROUP, NOW);

    expect(intake.submit).not.toHaveBeenCalled();
    expect(db.backorder.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { etaStage: 1, reestimateDecisionId: 'd-pending' },
      }),
    );
    expect(result).toEqual({ created: false, attached: 1 });
  });

  it('a replayed round (a concurrent tick created it first) attaches without counting a creation', async () => {
    const { service, db, intake } = build();
    db.$queryRaw
      .mockResolvedValueOnce(state(null, 0))
      .mockResolvedValueOnce([{ status: 'PENDING' }])
      .mockResolvedValueOnce([{ id: 'b-1' }]);
    db.backorder.updateMany.mockResolvedValue({ count: 1 });
    intake.submit.mockResolvedValue({
      status: 'replayed',
      request: { id: 'd-1', status: 'PENDING' },
    });
    expect(await service.requestForGroup(GROUP, NOW)).toEqual({
      created: false,
      attached: 1,
    });
  });

  it('opens the NEXT round only after the previous ones were answered', async () => {
    const { service, db, intake } = build();
    db.$queryRaw
      .mockResolvedValueOnce(state(null, 2))
      .mockResolvedValueOnce([{ status: 'PENDING' }])
      .mockResolvedValueOnce([]);
    intake.submit.mockResolvedValue(created('d-3'));
    await service.requestForGroup(GROUP, NOW);
    expect(intake.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceRequestId: reestimateSourceRequestId('t-1', 'p-1', null, 3),
      }),
      { staffOnly: true },
    );
  });

  it('a slow tick whose round was answered meanwhile (RESOLVED replay) re-reads and opens the next round', async () => {
    const { service, db, intake } = build();
    db.$queryRaw
      .mockResolvedValueOnce(state(null, 0)) // stale snapshot
      .mockResolvedValueOnce(state(null, 1)) // after the retry
      .mockResolvedValueOnce([{ status: 'PENDING' }])
      .mockResolvedValueOnce([{ id: 'b-1' }]);
    db.backorder.updateMany.mockResolvedValue({ count: 1 });
    intake.submit
      .mockResolvedValueOnce({
        status: 'replayed',
        request: { id: 'd-1', status: 'RESOLVED' },
      })
      .mockResolvedValueOnce(created('d-2'));

    const result = await service.requestForGroup(GROUP, NOW);

    expect(intake.submit).toHaveBeenCalledTimes(2);
    expect(intake.submit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sourceRequestId: reestimateSourceRequestId('t-1', 'p-1', null, 2),
      }),
      { staffOnly: true },
    );
    expect(result).toEqual({ created: true, attached: 1 });
  });

  it('a decision resolved between the submit and the attach attaches nothing (the next tick opens the next round)', async () => {
    const { service, db, intake } = build();
    db.$queryRaw
      .mockResolvedValueOnce(state('d-1', 1))
      .mockResolvedValueOnce([{ status: 'RESOLVED' }])
      // retry: nothing pending, a new round
      .mockResolvedValueOnce(state(null, 1))
      .mockResolvedValueOnce([{ status: 'PENDING' }])
      .mockResolvedValueOnce([{ id: 'b-1' }]);
    db.backorder.updateMany.mockResolvedValue({ count: 1 });
    intake.submit.mockResolvedValue(created('d-2'));
    const result = await service.requestForGroup(GROUP, NOW);
    expect(result).toEqual({ created: true, attached: 1 });
    expect(db.backorder.updateMany).toHaveBeenCalledTimes(1);
  });

  it('gives up after a bounded number of rounds instead of looping', async () => {
    const { service, db, intake } = build();
    db.$queryRaw.mockResolvedValue(state(null, 0));
    intake.submit.mockResolvedValue({
      status: 'replayed',
      request: { id: 'd-1', status: 'RESOLVED' },
    });
    expect(await service.requestForGroup(GROUP, NOW)).toEqual({
      created: false,
      attached: 0,
    });
    expect(intake.submit).toHaveBeenCalledTimes(3);
  });

  it.each(['IDEMPOTENCY_CONFLICT', 'VERSION_CONFLICT'] as const)(
    'a %s of the intake re-reads the state instead of failing the sweep',
    async (code) => {
      const { service, db, intake } = build();
      db.$queryRaw
        .mockResolvedValueOnce(state(null, 0))
        .mockResolvedValueOnce(state('d-won', 1))
        .mockResolvedValueOnce([{ status: 'PENDING' }])
        .mockResolvedValueOnce([{ id: 'b-1' }]);
      db.backorder.updateMany.mockResolvedValue({ count: 1 });
      intake.submit.mockRejectedValueOnce(new RestockIntakeError(code, 'x'));
      expect(await service.requestForGroup(GROUP, NOW)).toEqual({
        created: false,
        attached: 1,
      });
    },
  );

  it('any other intake failure propagates (the sweep backs the group off)', async () => {
    const { service, db, intake } = build();
    db.$queryRaw.mockResolvedValueOnce(state(null, 0));
    intake.submit.mockRejectedValue(new Error('db down'));
    await expect(service.requestForGroup(GROUP, NOW)).rejects.toThrow(
      'db down',
    );
  });

  it('a variant group uses the variant SKU and a distinct identity', async () => {
    const { service, db, intake } = build();
    db.$queryRaw
      .mockResolvedValueOnce(state(null, 0))
      .mockResolvedValueOnce([{ status: 'PENDING' }])
      .mockResolvedValueOnce([]);
    intake.submit.mockResolvedValue(created('d-1'));
    await service.requestForGroup({ ...GROUP, variantId: 'v-1' }, NOW);
    expect(intake.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        variantId: 'v-1',
        sku: 'VAR-1',
        sourceRequestId: reestimateSourceRequestId('t-1', 'p-1', 'v-1', 1),
      }),
      { staffOnly: true },
    );
    expect(reestimateSourceRequestId('t-1', 'p-1', 'v-1', 1)).not.toBe(
      reestimateSourceRequestId('t-1', 'p-1', null, 1),
    );
  });

  it('attaches nothing (and writes nothing) when no row is still overdue under the lock', async () => {
    const { service, db } = build();
    db.$queryRaw
      .mockResolvedValueOnce(state('d-1', 1))
      .mockResolvedValueOnce([{ status: 'PENDING' }])
      .mockResolvedValueOnce([]);
    expect(await service.requestForGroup(GROUP, NOW)).toEqual({
      created: false,
      attached: 0,
    });
    expect(db.backorder.updateMany).not.toHaveBeenCalled();
  });
});

describe('BackorderReestimateService.onRestockResolved (fan-out)', () => {
  const resolvedAt = new Date('2026-11-20T10:00:00.000Z');
  beforeEach(() => jest.clearAllMocks());

  it('PROVIDE: every WAITING attached backorder → etaStage 2, version +1, estimatedAt = resolvedAt + days, then its own eta_updated', async () => {
    const { service, db } = build();
    db.$queryRaw.mockResolvedValueOnce([{ id: 'b-1' }, { id: 'b-2' }]);
    db.backorder.updateMany.mockResolvedValue({ count: 1 });

    await service.onRestockResolved({
      tenantId: 't-1',
      decisionId: 'd-1',
      action: 'PROVIDE_RESTOCK_ESTIMATE',
      restockDays: 5,
      resolvedAt,
    });

    expect(db.backorder.updateMany).toHaveBeenCalledTimes(2);
    expect(db.backorder.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: 'b-1',
        tenantId: 't-1',
        status: 'WAITING',
        etaStage: 1,
        reestimateDecisionId: 'd-1',
      },
      data: {
        etaStage: 2,
        version: { increment: 1 },
        estimatedAt: new Date('2026-11-25T10:00:00.000Z'),
        estimatedArrivalDays: 5,
      },
    });
    expect(enqueueBackorderEtaUpdated).toHaveBeenCalledTimes(2);
    expect(enqueueBackorderEtaUpdated).toHaveBeenCalledWith(db, 't-1', 'b-1');
    expect(enqueueBackorderEtaUpdated).toHaveBeenCalledWith(db, 't-1', 'b-2');
    expect(enqueueBackorderEtaUnavailable).not.toHaveBeenCalled();
  });

  it('UNAVAILABLE: etaStage 2 and version +1 but estimatedAt / estimatedArrivalDays untouched; eta_unavailable', async () => {
    const { service, db } = build();
    db.$queryRaw.mockResolvedValueOnce([{ id: 'b-1' }]);
    db.backorder.updateMany.mockResolvedValue({ count: 1 });

    await service.onRestockResolved({
      tenantId: 't-1',
      decisionId: 'd-1',
      action: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
      restockDays: null,
      resolvedAt,
    });

    expect(db.backorder.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { etaStage: 2, version: { increment: 1 } },
      }),
    );
    expect(enqueueBackorderEtaUnavailable).toHaveBeenCalledWith(
      db,
      't-1',
      'b-1',
    );
    expect(enqueueBackorderEtaUpdated).not.toHaveBeenCalled();
  });

  it('a backorder another transaction moved (guarded update touches 0 rows) gets no message', async () => {
    const { service, db } = build();
    db.$queryRaw.mockResolvedValueOnce([{ id: 'b-1' }, { id: 'b-2' }]);
    db.backorder.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    await service.onRestockResolved({
      tenantId: 't-1',
      decisionId: 'd-1',
      action: 'PROVIDE_RESTOCK_ESTIMATE',
      restockDays: 2,
      resolvedAt,
    });
    expect(enqueueBackorderEtaUpdated).toHaveBeenCalledTimes(1);
    expect(enqueueBackorderEtaUpdated).toHaveBeenCalledWith(db, 't-1', 'b-2');
  });

  it('no attached WAITING backorder: nothing written, nothing fed', async () => {
    const { service, db } = build();
    db.$queryRaw.mockResolvedValueOnce([]);
    await service.onRestockResolved({
      tenantId: 't-1',
      decisionId: 'd-1',
      action: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
      restockDays: null,
      resolvedAt,
    });
    expect(db.backorder.updateMany).not.toHaveBeenCalled();
    expect(enqueueBackorderEtaUnavailable).not.toHaveBeenCalled();
  });

  it('a PROVIDE without days is not an answer: no query at all', async () => {
    const { service, db } = build();
    await service.onRestockResolved({
      tenantId: 't-1',
      decisionId: 'd-1',
      action: 'PROVIDE_RESTOCK_ESTIMATE',
      restockDays: null,
      resolvedAt,
    });
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('BackorderReestimateService.applyResolvedDecision (sweep repair)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('applies the answer of an already RESOLVED decision with the same rules', async () => {
    const { service, db } = build();
    db.humanDecision.findFirst.mockResolvedValue({
      resolutionAction: 'PROVIDE_RESTOCK_ESTIMATE',
      restockDays: 3,
      resolvedAt: new Date('2026-11-20T00:00:00.000Z'),
    });
    db.$queryRaw.mockResolvedValueOnce([{ id: 'b-1' }]);
    db.backorder.updateMany.mockResolvedValue({ count: 1 });

    expect(await service.applyResolvedDecision(db as never, 't-1', 'd-1')).toBe(
      1,
    );
    expect(db.backorder.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          estimatedAt: new Date('2026-11-23T00:00:00.000Z'),
        }) as unknown,
      }),
    );
    expect(enqueueBackorderEtaUpdated).toHaveBeenCalledTimes(1);
  });

  it('a decision that is not RESOLVED (or not a RESTOCK answer) applies nothing', async () => {
    const { service, db } = build();
    db.humanDecision.findFirst.mockResolvedValue(null);
    expect(await service.applyResolvedDecision(db as never, 't-1', 'd-1')).toBe(
      0,
    );
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('catalog snapshots for the RESTOCK canonicalizer', () => {
  it('cleans control characters and whitespace, clips at 200 code points and never returns an empty name', () => {
    expect(snapshotProductName('  Croquetas\t\n  Adulto  ')).toBe(
      'Croquetas Adulto',
    );
    expect(snapshotProductName('x'.repeat(300))).toHaveLength(200);
    expect(snapshotProductName('😀'.repeat(250))).toBe('😀'.repeat(200));
    expect(snapshotProductName('\n\t ')).toBe('Producto');
  });

  it('keeps a clean SKU, strips controls, and turns blank into null', () => {
    expect(snapshotSku('AB-1')).toBe('AB-1');
    expect(snapshotSku('AB\n1')).toBe('AB 1');
    expect(snapshotSku('  ')).toBeNull();
    expect(snapshotSku(null)).toBeNull();
  });
});
