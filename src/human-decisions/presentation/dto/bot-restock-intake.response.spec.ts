/**
 * HD-03b1 — BotRestockIntakeResponse projection spec.
 *
 * Proves the bot-safe POST intake RECEIPT is an immutable historical
 * projection: it always reports the intake moment (`PENDING`/version `1`,
 * `resolution:null`, `applyBefore:null`) with the persisted branch snapshot,
 * regardless of the row's later mutable state. `GET` bot poll (HD-05) is the
 * only source that ever exposes `RESOLVED`/version `2`.
 *
 * The approved bot body is exactly:
 * `{id,sourceRequestId,type:'RESTOCK',status:'PENDING',version:1,createdAt,
 * snapshot:{branchId,branchName,productId,productName,variantId,sku,
 * requestedQuantity,observedStockAtRequest,stockObservedAt},
 * supersedesDecisionId,resolution:null,applyBefore:null}`.
 */
import {
  RESTOCK_SOURCE,
  RESTOCK_TYPE,
} from '../../domain/restock-request-canonicalizer';
import type {
  PersistedRestockDecision,
  PersistedRestockDecisionSnapshot,
} from '../../domain/restock-intake.repository';
import {
  toBotRestockIntakeResponse,
  type BotRestockIntakeResponse,
} from './bot-restock-intake.response';

const DECISION_ID = '2b7c1a90-6f3e-4d2a-8b1c-0d9e8f7a6b5c';
const SOURCE_REQUEST_ID = '3f1c1b7a-9c2e-4d5f-8a6b-1c2d3e4f5a6b';
const PRODUCT_ID = '8f14e45f-ceea-4e42-9f62-1a2b3c4d5e6f';
const VARIANT_ID = '550e8400-e29b-41d4-a716-446655440000';
const SUPERSEDES_ID = 'a1b2c3d4-e5f6-4789-8abc-def012345678';
const BRANCH_ID = 'branch-1';
const BRANCH_NAME = 'Sucursal Centro';
const PRODUCT_NAME = 'Filtro de aceite';
const SKU = 'SKU-1';
const REQUESTED_QUANTITY = 3;
const OBSERVED_STOCK = 0;
const CREATED_AT_ISO = '2026-02-01T10:00:00.000Z';
const OBSERVED_AT_ISO = '2026-01-31T23:30:00.000Z';
const CANONICAL_HASH_SENTINEL = 'canonical-request-hash-sentinel';

const EXPECTED_TOP_LEVEL_KEYS = [
  'id',
  'sourceRequestId',
  'type',
  'status',
  'version',
  'createdAt',
  'snapshot',
  'supersedesDecisionId',
  'resolution',
  'applyBefore',
];

const EXPECTED_SNAPSHOT_KEYS = [
  'branchId',
  'branchName',
  'productId',
  'productName',
  'variantId',
  'sku',
  'requestedQuantity',
  'observedStockAtRequest',
  'stockObservedAt',
];

/** Keys that must NEVER appear on the bot receipt (authority/PII/mutable state). */
const FORBIDDEN_KEYS = [
  'source',
  'canonicalRequestHash',
  'hash',
  'submittedCredentialId',
  'credentialId',
  'tenantId',
  'allowedActions',
  'resolutionRequestId',
  'reviewer',
  'resolvedAt',
  'resolvedBy',
  'audit',
  'pii',
  'customerPhone',
  'updatedAt',
];

/** Persisted-row overrides; the snapshot is deep-merged with the defaults. */
type DecisionOverrides = Partial<Omit<PersistedRestockDecision, 'snapshot'>> & {
  snapshot?: Partial<PersistedRestockDecisionSnapshot>;
};

function utcDate(iso: string): Date {
  return new Date(iso);
}

function persistedDecision(
  overrides: DecisionOverrides = {},
): PersistedRestockDecision {
  const snapshot: PersistedRestockDecisionSnapshot = {
    branchId: BRANCH_ID,
    branchName: BRANCH_NAME,
    productId: PRODUCT_ID,
    productName: PRODUCT_NAME,
    variantId: VARIANT_ID,
    sku: SKU,
    requestedQuantity: REQUESTED_QUANTITY,
    observedStockAtRequest: OBSERVED_STOCK,
    stockObservedAt: utcDate(OBSERVED_AT_ISO),
    ...overrides.snapshot,
  };

  return {
    id: DECISION_ID,
    source: RESTOCK_SOURCE,
    sourceRequestId: SOURCE_REQUEST_ID,
    type: RESTOCK_TYPE,
    canonicalRequestHash: CANONICAL_HASH_SENTINEL,
    status: 'PENDING',
    version: 1,
    supersedesDecisionId: null,
    createdAt: utcDate(CREATED_AT_ISO),
    ...overrides,
    snapshot,
  };
}

/** Attaches server-only / mutable columns the mapper must ignore. */
function withServerOnlyFields(
  decision: PersistedRestockDecision,
  extras: Record<string, unknown>,
): PersistedRestockDecision {
  return Object.assign(decision, extras);
}

describe('toBotRestockIntakeResponse — immutable intake receipt shape', () => {
  it('exposes exactly the bot-safe top-level key set', () => {
    const body = toBotRestockIntakeResponse(persistedDecision());

    expect(Object.keys(body).sort()).toEqual(
      [...EXPECTED_TOP_LEVEL_KEYS].sort(),
    );
  });

  it('exposes exactly the persisted snapshot keys', () => {
    const body = toBotRestockIntakeResponse(persistedDecision());

    expect(Object.keys(body.snapshot).sort()).toEqual(
      [...EXPECTED_SNAPSHOT_KEYS].sort(),
    );
  });

  it('returns the fixed receipt values for a freshly created decision', () => {
    const body = toBotRestockIntakeResponse(persistedDecision());

    expect(body.id).toBe(DECISION_ID);
    expect(body.sourceRequestId).toBe(SOURCE_REQUEST_ID);
    expect(body.type).toBe('RESTOCK');
    expect(body.status).toBe('PENDING');
    expect(body.version).toBe(1);
    expect(body.resolution).toBeNull();
    expect(body.applyBefore).toBeNull();
    expect(body.supersedesDecisionId).toBeNull();
  });

  it('uses the persisted branch name from the immutable snapshot (never re-reads tenant)', () => {
    const body = toBotRestockIntakeResponse(
      persistedDecision({ snapshot: { branchName: BRANCH_NAME } }),
    );

    expect(body.snapshot.branchName).toBe(BRANCH_NAME);
    expect(body.snapshot.branchId).toBe(BRANCH_ID);
  });

  it('passes a non-null supersedesDecisionId straight through', () => {
    const body = toBotRestockIntakeResponse(
      persistedDecision({ supersedesDecisionId: SUPERSEDES_ID }),
    );

    expect(body.supersedesDecisionId).toBe(SUPERSEDES_ID);
  });

  it('is assignable to the declared response type', () => {
    const body: BotRestockIntakeResponse =
      toBotRestockIntakeResponse(persistedDecision());

    expect(body.type).toBe('RESTOCK');
  });
});

describe('toBotRestockIntakeResponse — immutable historical receipt', () => {
  it('returns identical values on first create and on replay after resolution', () => {
    const first = toBotRestockIntakeResponse(
      persistedDecision({ status: 'PENDING', version: 1 }),
    );
    const replayed = toBotRestockIntakeResponse(
      persistedDecision({ status: 'RESOLVED', version: 2 }),
    );

    expect(replayed).toEqual(first);
    expect(replayed).not.toBe(first);
    expect(replayed.status).toBe('PENDING');
    expect(replayed.version).toBe(1);
    expect(replayed.resolution).toBeNull();
    expect(replayed.applyBefore).toBeNull();
  });

  it('never presents the mutable persisted status/version as current state', () => {
    const resolved = toBotRestockIntakeResponse(
      persistedDecision({ status: 'RESOLVED', version: 2 }),
    );

    expect(resolved).not.toHaveProperty('status', 'RESOLVED');
    expect(resolved).not.toHaveProperty('version', 2);
  });
});

describe('toBotRestockIntakeResponse — UTC ISO date projection', () => {
  it('normalizes createdAt and stockObservedAt to canonical UTC ISO', () => {
    const body = toBotRestockIntakeResponse(
      persistedDecision({
        createdAt: utcDate('2026-02-01T12:00:00+02:00'),
        snapshot: {
          stockObservedAt: utcDate('2026-01-31T23:30:00+02:00'),
        },
      }),
    );

    expect(body.createdAt).toBe('2026-02-01T10:00:00.000Z');
    expect(body.snapshot.stockObservedAt).toBe('2026-01-31T21:30:00.000Z');
    expect(body.createdAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(body.snapshot.stockObservedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it('projects a null stockObservedAt without dropping any snapshot key', () => {
    const body = toBotRestockIntakeResponse(
      persistedDecision({
        snapshot: {
          branchName: null,
          variantId: null,
          sku: null,
          requestedQuantity: null,
          observedStockAtRequest: null,
          stockObservedAt: null,
        },
      }),
    );

    expect(body.snapshot).toEqual({
      branchId: BRANCH_ID,
      branchName: null,
      productId: PRODUCT_ID,
      productName: PRODUCT_NAME,
      variantId: null,
      sku: null,
      requestedQuantity: null,
      observedStockAtRequest: null,
      stockObservedAt: null,
    });
    expect(Object.keys(body.snapshot).sort()).toEqual(
      [...EXPECTED_SNAPSHOT_KEYS].sort(),
    );
  });
});

describe('toBotRestockIntakeResponse — purity', () => {
  it('does not mutate the input dates or snapshot object', () => {
    const createdAt = utcDate(CREATED_AT_ISO);
    const stockObservedAt = utcDate(OBSERVED_AT_ISO);
    const decision = persistedDecision({ createdAt });
    decision.snapshot.stockObservedAt = stockObservedAt;
    const snapshotRef = decision.snapshot;
    const createdTime = createdAt.getTime();
    const observedTime = stockObservedAt.getTime();

    toBotRestockIntakeResponse(decision);

    expect(createdAt.getTime()).toBe(createdTime);
    expect(stockObservedAt.getTime()).toBe(observedTime);
    expect(decision.snapshot).toBe(snapshotRef);
    expect(decision.snapshot.stockObservedAt).toBe(stockObservedAt);
    expect(decision.createdAt).toBe(createdAt);
  });

  it('maps a frozen immutable input without throwing', () => {
    const decision = persistedDecision();
    Object.freeze(decision.snapshot);
    Object.freeze(decision);

    expect(() => toBotRestockIntakeResponse(decision)).not.toThrow();
  });
});

describe('toBotRestockIntakeResponse — no authority/PII leaks', () => {
  it('omits every forbidden key from the top level and the snapshot', () => {
    const body = toBotRestockIntakeResponse(persistedDecision());

    for (const key of FORBIDDEN_KEYS) {
      expect(body).not.toHaveProperty(key);
      expect(body.snapshot).not.toHaveProperty(key);
    }
  });

  it('keeps branchId only inside the snapshot, never at the top level', () => {
    const body = toBotRestockIntakeResponse(persistedDecision());

    expect(body.snapshot).toHaveProperty('branchId', BRANCH_ID);
    expect(body).not.toHaveProperty('branchId');
  });

  it('ignores server-only fields even when the persisted row carries them', () => {
    const body = toBotRestockIntakeResponse(
      withServerOnlyFields(persistedDecision(), {
        tenantId: 'TENANT-SECRET',
        submittedCredentialId: 'CREDENTIAL-SECRET',
        canonicalRequestHash: 'HASH-SECRET',
        allowedActions: ['PROVIDE_RESTOCK_ESTIMATE'],
        resolution: { action: 'PROVIDE_RESTOCK_ESTIMATE', restockDays: 5 },
        reviewer: { displayName: 'REVIEWER-SECRET' },
        audit: { reason: 'AUDIT-SECRET' },
        pii: 'PII-SECRET',
        updatedAt: utcDate('2026-03-01T00:00:00.000Z'),
      }),
    );

    const serialized = JSON.stringify(body);

    for (const sentinel of [
      'TENANT-SECRET',
      'CREDENTIAL-SECRET',
      'HASH-SECRET',
      'REVIEWER-SECRET',
      'AUDIT-SECRET',
      'PII-SECRET',
      'PROVIDE_RESTOCK_ESTIMATE',
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
    expect(serialized).not.toContain(RESTOCK_SOURCE);
  });

  it('never surfaces the canonical request hash or the persisted source', () => {
    const body = toBotRestockIntakeResponse(persistedDecision());

    expect(body).not.toHaveProperty('canonicalRequestHash');
    expect(body).not.toHaveProperty('source');
    expect(JSON.stringify(body)).not.toContain(CANONICAL_HASH_SENTINEL);
  });
});
