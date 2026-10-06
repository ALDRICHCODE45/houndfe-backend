/**
 * HD-05a1 — BotRestockPollResponse projection spec.
 *
 * Proves the bot `GET` poll projection is the ONLY source of CURRENT decision
 * state: it discriminates `PENDING` (version 1, `resolution:null`,
 * `applyBefore:null`) from `RESOLVED` (version 2, typed resolution and
 * `applyBefore = resolvedAt + 1h` UTC ISO). The HUMAN POST intake receipt
 * (HD-03b1) stays historical and is asserted here again against a mutable,
 * resolved record so the two projections can never be confused.
 *
 * The approved bot body is exactly the 10 top-level keys:
 * `{id,sourceRequestId,type:'RESTOCK',status,version,createdAt,
 * snapshot:{branchId,branchName,productId,productName,variantId,sku,
 * requestedQuantity,observedStockAtRequest,stockObservedAt},
 * supersedesDecisionId,resolution,applyBefore}`.
 *
 * Deliberately ABSENT (reviewer identity / authority / ACK): `resolvedBy`,
 * `resolvedById`/`resolvedByActorId`/`resolvedByDisplayName`, `source`,
 * `tenantId`, `canonicalRequestHash`, `submittedCredentialId`, provider/ACK
 * evidence, customer PII. The domain read record has NO `source` field: the
 * Prisma adapter pins `source`/`type`/tenant in the WHERE clause, so a caller
 * can never widen this projection by injecting a `source`.
 */
import { EXPIRATION_TYPE } from '../../domain/expiration-intake.request';
import { RESTOCK_SOURCE } from '../../domain/restock-request-canonicalizer';
import { RESTOCK_TYPE } from '../../domain/restock-request-canonicalizer';
import type { PersistedRestockDecision } from '../../domain/restock-intake.repository';
import {
  HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE,
  HUMAN_DECISION_RESOLUTION_REPORT_UNAVAILABLE,
} from '../../domain/human-decision-review-resolve.repository';
import type {
  BotRestockPollRecord,
  BotRestockPollSnapshotRecord,
} from '../../domain/bot-restock-poll.repository';
import { toBotRestockIntakeResponse } from './bot-restock-intake.response';
import {
  toBotExpirationPollResponse,
  toBotRestockPollResponse,
  type BotExpirationPollResponse,
  type BotRestockPollResponse,
} from './bot-restock-poll.response';

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
const RESTOCK_DAYS = 5;
const CREATED_AT_ISO = '2026-02-01T10:00:00.000Z';
const OBSERVED_AT_ISO = '2026-01-31T23:30:00.000Z';
const RESOLVED_AT_ISO = '2026-02-01T23:30:00.000Z';
const APPLY_BEFORE_ISO = '2026-02-02T00:30:00.000Z';
// EXPIRATION shares `resolvedAt` but the owner-approved deadline is 24h.
const EXPIRATION_APPLY_BEFORE_ISO = '2026-02-02T23:30:00.000Z';
const EXPIRATION_POSITIVE_ACTION = 'PROVIDE_EXPIRATION_TEXT';
const EXPIRATION_NEGATIVE_ACTION = 'REPORT_EXPIRATION_UNAVAILABLE';
const EXPIRATION_UNIT = 'UNIDAD';
const EXPIRATION_VARIANT_NAME = 'Presentación A';
const EXPIRATION_VARIANT_OPTION = 'Peso';
const EXPIRATION_VARIANT_VALUE = '1 kg';
const EXPIRATION_TEXT = 'Vence el 2026-05';
const EXPIRATION_UNTRIMMED_TEXT = '  Vence   el 2026-05  ';

const NFD_PRODUCT_NAME = 'Caf\u0065\u0301';
const NFD_SKU = 'Caf\u0065\u0301';
const C0_CONTROL = '\u0000';
const C1_CONTROL = '\u0085';

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

/** EXPIRATION snapshot has `unit` and NO sku/restock field. */
const EXPECTED_EXPIRATION_SNAPSHOT_KEYS = [
  'branchId',
  'branchName',
  'productId',
  'productName',
  'unit',
  'variantId',
  'variantName',
  'variantOption',
  'variantValue',
];

/** Must NEVER appear on an EXPIRATION body/snapshot. */
const EXPIRATION_FORBIDDEN_KEYS = [
  'sku',
  'requestedQuantity',
  'observedStockAtRequest',
  'stockObservedAt',
  'restockDays',
  'productUnit',
];

/** Keys that must NEVER appear on the bot poll body (reviewer identity/authority). */
const FORBIDDEN_KEYS = [
  'source',
  'canonicalRequestHash',
  'hash',
  'submittedCredentialId',
  'credentialId',
  'tenantId',
  'resolvedBy',
  'resolvedById',
  'resolvedByActorId',
  'resolvedByDisplayName',
  'reviewer',
  'reviewerId',
  'resolutionRequestId',
  'allowedActions',
  'applicationOutcome',
  'applicationAttemptId',
  'providerMessageId',
  'providerAcceptedObservedAt',
  'ackReceivedAt',
  'audit',
  'auditReason',
  'pii',
  'customerPhone',
  'customerAddress',
  'transcript',
  'updatedAt',
];

/** Persisted-row overrides; the snapshot is deep-merged with the defaults. */
type PollOverrides = Partial<Omit<BotRestockPollRecord, 'snapshot'>> & {
  snapshot?: Partial<BotRestockPollSnapshotRecord>;
};

function utcDate(iso: string): Date {
  return new Date(iso);
}

function botPollRecord(overrides: PollOverrides = {}): BotRestockPollRecord {
  const snapshot: BotRestockPollSnapshotRecord = {
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
    sourceRequestId: SOURCE_REQUEST_ID,
    type: RESTOCK_TYPE,
    status: 'PENDING',
    version: 1,
    createdAt: utcDate(CREATED_AT_ISO),
    supersedesDecisionId: null,
    resolutionAction: null,
    restockDays: null,
    resolvedAt: null,
    ...overrides,
    snapshot,
  };
}

function resolvedRecord(overrides: PollOverrides = {}): BotRestockPollRecord {
  return botPollRecord({
    status: 'RESOLVED',
    version: 2,
    resolutionAction: HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE,
    restockDays: RESTOCK_DAYS,
    resolvedAt: utcDate(RESOLVED_AT_ISO),
    ...overrides,
  });
}

/** Persisted EXPIRATION row; EXPIRATION forbids every RESTOCK-only snapshot field. */
function expirationPollRecord(
  overrides: PollOverrides = {},
): BotRestockPollRecord {
  const snapshot: BotRestockPollSnapshotRecord = {
    branchId: BRANCH_ID,
    branchName: BRANCH_NAME,
    productId: PRODUCT_ID,
    productName: PRODUCT_NAME,
    variantId: null,
    sku: null,
    requestedQuantity: null,
    observedStockAtRequest: null,
    stockObservedAt: null,
    productUnit: EXPIRATION_UNIT,
    variantName: null,
    variantOption: null,
    variantValue: null,
    ...overrides.snapshot,
  };

  return {
    id: DECISION_ID,
    sourceRequestId: SOURCE_REQUEST_ID,
    type: EXPIRATION_TYPE,
    status: 'PENDING',
    version: 1,
    createdAt: utcDate(CREATED_AT_ISO),
    supersedesDecisionId: null,
    resolutionAction: null,
    restockDays: null,
    expirationText: null,
    resolvedAt: null,
    ...overrides,
    snapshot,
  };
}

/** Identity variant product: `variantName` is required, option/value nullable. */
function expirationVariantRecord(
  overrides: PollOverrides = {},
): BotRestockPollRecord {
  return expirationPollRecord({
    ...overrides,
    snapshot: {
      variantId: VARIANT_ID,
      variantName: EXPIRATION_VARIANT_NAME,
      variantOption: EXPIRATION_VARIANT_OPTION,
      variantValue: EXPIRATION_VARIANT_VALUE,
      ...overrides.snapshot,
    },
  });
}

function resolvedExpirationRecord(
  overrides: PollOverrides = {},
): BotRestockPollRecord {
  return expirationPollRecord({
    status: 'RESOLVED',
    version: 2,
    resolutionAction: EXPIRATION_POSITIVE_ACTION,
    expirationText: EXPIRATION_TEXT,
    resolvedAt: utcDate(RESOLVED_AT_ISO),
    ...overrides,
  });
}

/** Attaches server-only / mutable columns the mapper must ignore. */
function withExtraFields(
  record: BotRestockPollRecord,
  extras: Record<string, unknown>,
): BotRestockPollRecord {
  return Object.assign(record, extras);
}

/** Minimal historical intake row used to prove the receipt stays immutable. */
function persistedIntakeDecision(): PersistedRestockDecision {
  return {
    id: DECISION_ID,
    source: RESTOCK_SOURCE,
    sourceRequestId: SOURCE_REQUEST_ID,
    type: RESTOCK_TYPE,
    canonicalRequestHash: 'canonical-hash-sentinel',
    status: 'RESOLVED',
    version: 2,
    supersedesDecisionId: null,
    createdAt: utcDate(CREATED_AT_ISO),
    snapshot: {
      branchId: BRANCH_ID,
      branchName: BRANCH_NAME,
      productId: PRODUCT_ID,
      productName: PRODUCT_NAME,
      variantId: VARIANT_ID,
      sku: SKU,
      requestedQuantity: REQUESTED_QUANTITY,
      observedStockAtRequest: OBSERVED_STOCK,
      stockObservedAt: utcDate(OBSERVED_AT_ISO),
    },
  };
}

describe('toBotRestockPollResponse — exact shape', () => {
  it('exposes exactly the bot-safe top-level key set for PENDING', () => {
    const body = toBotRestockPollResponse(botPollRecord());

    expect(Object.keys(body).sort()).toEqual(
      [...EXPECTED_TOP_LEVEL_KEYS].sort(),
    );
  });

  it('exposes the same exact top-level key set for RESOLVED', () => {
    const body = toBotRestockPollResponse(resolvedRecord());

    expect(Object.keys(body).sort()).toEqual(
      [...EXPECTED_TOP_LEVEL_KEYS].sort(),
    );
    expect(Object.keys(body).length).toBe(10);
  });

  it('exposes exactly the persisted snapshot keys', () => {
    const body = toBotRestockPollResponse(botPollRecord());

    expect(Object.keys(body.snapshot).sort()).toEqual(
      [...EXPECTED_SNAPSHOT_KEYS].sort(),
    );
  });

  it('narrows the declared discriminated union on status', () => {
    const pending: BotRestockPollResponse =
      toBotRestockPollResponse(botPollRecord());
    const resolved: BotRestockPollResponse =
      toBotRestockPollResponse(resolvedRecord());

    expect(pending.status).toBe('PENDING');
    expect(resolved.status).toBe('RESOLVED');
    if (pending.status === 'PENDING') {
      expect(pending.version).toBe(1);
      expect(pending.resolution).toBeNull();
      expect(pending.applyBefore).toBeNull();
    }
    if (resolved.status === 'RESOLVED') {
      expect(resolved.version).toBe(2);
      expect(resolved.applyBefore).toBe(APPLY_BEFORE_ISO);
    }
  });
});

describe('toBotRestockPollResponse — PENDING projection', () => {
  it('reports the current PENDING state with no resolution and no deadline', () => {
    const body = toBotRestockPollResponse(
      botPollRecord({ supersedesDecisionId: SUPERSEDES_ID }),
    );

    expect(body.id).toBe(DECISION_ID);
    expect(body.sourceRequestId).toBe(SOURCE_REQUEST_ID);
    expect(body.type).toBe('RESTOCK');
    expect(body.status).toBe('PENDING');
    expect(body.version).toBe(1);
    expect(body.createdAt).toBe(CREATED_AT_ISO);
    expect(body.supersedesDecisionId).toBe(SUPERSEDES_ID);
    expect(body.resolution).toBeNull();
    expect(body.applyBefore).toBeNull();
  });

  it('keeps an optional supersedesDecisionId present as an explicit null', () => {
    const body = toBotRestockPollResponse(botPollRecord());

    expect(body).toHaveProperty('supersedesDecisionId', null);
    expect(body.supersedesDecisionId).toBeNull();
  });

  it('projects the persisted branch snapshot without re-reading tenant', () => {
    const body = toBotRestockPollResponse(botPollRecord());

    expect(body.snapshot).toEqual({
      branchId: BRANCH_ID,
      branchName: BRANCH_NAME,
      productId: PRODUCT_ID,
      productName: PRODUCT_NAME,
      variantId: VARIANT_ID,
      sku: SKU,
      requestedQuantity: REQUESTED_QUANTITY,
      observedStockAtRequest: OBSERVED_STOCK,
      stockObservedAt: OBSERVED_AT_ISO,
    });
  });

  it('projects a fully-null optional snapshot without dropping any key', () => {
    const body = toBotRestockPollResponse(
      botPollRecord({
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

    expect(Object.keys(body.snapshot).sort()).toEqual(
      [...EXPECTED_SNAPSHOT_KEYS].sort(),
    );
    expect(body.snapshot.branchName).toBeNull();
    expect(body.snapshot.variantId).toBeNull();
    expect(body.snapshot.sku).toBeNull();
    expect(body.snapshot.requestedQuantity).toBeNull();
    expect(body.snapshot.observedStockAtRequest).toBeNull();
    expect(body.snapshot.stockObservedAt).toBeNull();
  });
});

describe('toBotRestockPollResponse — RESOLVED projection', () => {
  it('projects the positive estimate with days and applyBefore+1h', () => {
    const body = toBotRestockPollResponse(resolvedRecord());

    expect(body.status).toBe('RESOLVED');
    expect(body.version).toBe(2);
    expect(body.resolution).toEqual({
      action: 'PROVIDE_RESTOCK_ESTIMATE',
      restockDays: RESTOCK_DAYS,
      resolvedAt: RESOLVED_AT_ISO,
    });
    expect(Object.keys(body.resolution as object).sort()).toEqual(
      ['action', 'restockDays', 'resolvedAt'].sort(),
    );
    expect(body.applyBefore).toBe(APPLY_BEFORE_ISO);
  });

  it('projects the negative resolution with no restockDays property', () => {
    const body = toBotRestockPollResponse(
      resolvedRecord({
        resolutionAction: HUMAN_DECISION_RESOLUTION_REPORT_UNAVAILABLE,
        restockDays: null,
      }),
    );

    expect(body.version).toBe(2);
    expect(body.resolution).toEqual({
      action: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
      resolvedAt: RESOLVED_AT_ISO,
    });
    expect(body.resolution).not.toHaveProperty('restockDays');
    expect(Object.keys(body.resolution as object).sort()).toEqual([
      'action',
      'resolvedAt',
    ]);
    expect(body.applyBefore).toBe(APPLY_BEFORE_ISO);
  });

  it('crosses midnight when deriving applyBefore = resolvedAt + 1h', () => {
    const body = toBotRestockPollResponse(
      resolvedRecord({ resolvedAt: utcDate('2026-02-01T23:30:00.000Z') }),
    );

    expect(body.applyBefore).toBe('2026-02-02T00:30:00.000Z');
    expect(body.applyBefore).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it('normalizes resolvedAt and applyBefore to canonical UTC ISO', () => {
    const body = toBotRestockPollResponse(
      resolvedRecord({ resolvedAt: utcDate('2026-02-01T20:30:00+01:00') }),
    );

    expect((body.resolution as { resolvedAt: string }).resolvedAt).toBe(
      '2026-02-01T19:30:00.000Z',
    );
    expect(body.applyBefore).toBe('2026-02-01T20:30:00.000Z');
  });

  it('never surfaces a resolvedBy on either resolution variant', () => {
    const positive = toBotRestockPollResponse(resolvedRecord());
    const negative = toBotRestockPollResponse(
      resolvedRecord({
        resolutionAction: HUMAN_DECISION_RESOLUTION_REPORT_UNAVAILABLE,
        restockDays: null,
      }),
    );

    for (const body of [positive, negative]) {
      expect(body.resolution).not.toHaveProperty('resolvedBy');
      expect(body.resolution).not.toHaveProperty('resolvedById');
      expect(body.resolution).not.toHaveProperty('resolvedByDisplayName');
    }
  });
});

describe('toBotRestockPollResponse — current state vs historical receipt', () => {
  it('lets the poll expose RESOLVED while the POST receipt stays historical', () => {
    const record = resolvedRecord();
    const poll = toBotRestockPollResponse(record);
    const receipt = toBotRestockIntakeResponse(persistedIntakeDecision());

    expect(poll.status).toBe('RESOLVED');
    expect(poll.version).toBe(2);
    expect(receipt.status).toBe('PENDING');
    expect(receipt.version).toBe(1);
    expect(receipt.resolution).toBeNull();
    expect(receipt.applyBefore).toBeNull();
  });

  it('does not mutate the poll record when projecting', () => {
    const resolvedAt = utcDate(RESOLVED_AT_ISO);
    const record = resolvedRecord({ resolvedAt });
    const snapshotRef = record.snapshot;
    const resolvedTime = resolvedAt.getTime();

    toBotRestockPollResponse(record);

    expect(resolvedAt.getTime()).toBe(resolvedTime);
    expect(record.snapshot).toBe(snapshotRef);
    expect(record.resolvedAt).toBe(resolvedAt);
    expect(record.status).toBe('RESOLVED');
  });
});

describe('toBotRestockPollResponse — fail-closed on malformed state', () => {
  /** A fully-formed VALID resolved baseline to corrupt per case. */
  const resolvedBase: PollOverrides = {
    status: 'RESOLVED',
    version: 2,
    resolutionAction: HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE,
    restockDays: RESTOCK_DAYS,
    resolvedAt: utcDate(RESOLVED_AT_ISO),
  };

  const invalidRecords: Array<[string, PollOverrides]> = [
    ['a pending row pinned to version 2', { status: 'PENDING', version: 2 }],
    [
      'a pending row carrying a resolution action',
      {
        status: 'PENDING',
        version: 1,
        resolutionAction: HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE,
      },
    ],
    [
      'a pending row carrying restock days',
      { status: 'PENDING', version: 1, restockDays: 5 },
    ],
    [
      'a pending row carrying resolvedAt',
      { status: 'PENDING', version: 1, resolvedAt: utcDate(RESOLVED_AT_ISO) },
    ],
    ['an unknown status', { status: 'EXPIRED' }],
    ['a resolved row pinned to version 1', { ...resolvedBase, version: 1 }],
    ['a resolved row pinned to version 3', { ...resolvedBase, version: 3 }],
    [
      'a resolved row with no resolvedAt',
      { ...resolvedBase, resolvedAt: null },
    ],
    [
      'a resolved row with an unknown action',
      { ...resolvedBase, resolutionAction: 'BOGUS' },
    ],
    [
      'a positive row with no restock days',
      { ...resolvedBase, restockDays: null },
    ],
    ['a positive row with zero days', { ...resolvedBase, restockDays: 0 }],
    ['a positive row over 365 days', { ...resolvedBase, restockDays: 366 }],
    [
      'a positive row with fractional days',
      { ...resolvedBase, restockDays: 1.5 },
    ],
    [
      'a negative row carrying restock days',
      {
        ...resolvedBase,
        resolutionAction: HUMAN_DECISION_RESOLUTION_REPORT_UNAVAILABLE,
        restockDays: 4,
      },
    ],
    [
      'a resolved row with an invalid resolvedAt',
      { ...resolvedBase, resolvedAt: new Date('invalid') },
    ],
    ['a non-RESTOCK persisted type', { type: 'SHIPPING' }],
    ['a nil decision UUID', { id: '00000000-0000-0000-0000-000000000000' }],
    ['a noncanonical decision UUID', { id: DECISION_ID.toUpperCase() }],
    [
      'a nil sourceRequestId UUID',
      { sourceRequestId: '00000000-0000-0000-0000-000000000000' },
    ],
    [
      'a nil supersedesDecisionId',
      { supersedesDecisionId: '00000000-0000-0000-0000-000000000000' },
    ],
    ['an invalid createdAt', { createdAt: new Date('invalid') }],
    ['an invalid resolvedAt', { resolvedAt: new Date('invalid') }],
    [
      'an invalid observed timestamp',
      { snapshot: { stockObservedAt: new Date('invalid') } },
    ],
    ['an empty branchId', { snapshot: { branchId: '' } }],
    ['a blank branchId', { snapshot: { branchId: '   ' } }],
    ['an invalid product UUID', { snapshot: { productId: 'not-a-uuid' } }],
    ['an invalid variant UUID', { snapshot: { variantId: 'not-a-uuid' } }],
    ['an empty product name', { snapshot: { productName: '' } }],
    ['a whitespace-only product name', { snapshot: { productName: '   ' } }],
    ['a non-NFC product name', { snapshot: { productName: NFD_PRODUCT_NAME } }],
    [
      'an untrimmed product name',
      { snapshot: { productName: ` ${PRODUCT_NAME} ` } },
    ],
    [
      'a collapsed-space product name',
      { snapshot: { productName: 'Filtro  de aceite' } },
    ],
    [
      'an over-long product name',
      { snapshot: { productName: 'a'.repeat(201) } },
    ],
    [
      'a C0-control product name',
      { snapshot: { productName: `Filtro${C0_CONTROL}aceite` } },
    ],
    [
      'a C1-control product name',
      { snapshot: { productName: `Filtro${C1_CONTROL}aceite` } },
    ],
    ['an untrimmed sku', { snapshot: { sku: ` ${SKU} ` } }],
    ['a non-NFC sku', { snapshot: { sku: NFD_SKU } }],
    ['a blank sku', { snapshot: { sku: '' } }],
    ['a C0-control sku', { snapshot: { sku: `SKU${C0_CONTROL}` } }],
    ['a C1-control sku', { snapshot: { sku: `SKU${C1_CONTROL}` } }],
    ['a zero requested quantity', { snapshot: { requestedQuantity: 0 } }],
    ['a negative requested quantity', { snapshot: { requestedQuantity: -2 } }],
    [
      'a fractional requested quantity',
      { snapshot: { requestedQuantity: 1.5 } },
    ],
    ['a negative observed stock', { snapshot: { observedStockAtRequest: -1 } }],
    [
      'an observation count without a timestamp',
      { snapshot: { observedStockAtRequest: 4, stockObservedAt: null } },
    ],
    [
      'an observation timestamp without a count',
      {
        snapshot: {
          observedStockAtRequest: null,
          stockObservedAt: utcDate(OBSERVED_AT_ISO),
        },
      },
    ],
  ];

  it.each(invalidRecords)(
    'rejects a persisted row with %s',
    (_label, overrides) => {
      expect(() => toBotRestockPollResponse(botPollRecord(overrides))).toThrow(
        'Malformed persisted bot restock poll state',
      );
    },
  );

  it('fails closed when resolvedAt + 1h overflows the Date range', () => {
    const record = resolvedRecord({
      resolvedAt: new Date(8_640_000_000_000_000),
    });

    expect(() => toBotRestockPollResponse(record)).toThrow(
      'Malformed persisted bot restock poll state',
    );
  });

  it('throws a value-free error that never echoes persisted values', () => {
    const record = resolvedRecord({
      resolutionAction: 'BOGUS_ACTION',
      restockDays: 5,
      snapshot: {
        productName: 'PRODUCT-NAME-SENTINEL',
        sku: 'SKU-SENTINEL',
      },
    });

    let message = '';
    try {
      toBotRestockPollResponse(record);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).not.toBe('');
    expect(message).not.toContain('BOGUS_ACTION');
    expect(message).not.toContain('PRODUCT-NAME-SENTINEL');
    expect(message).not.toContain('SKU-SENTINEL');
    expect(message).not.toContain(DECISION_ID);
  });
});

describe('toBotRestockPollResponse — no reviewer identity / authority / PII leaks', () => {
  it('omits every forbidden key from the top level and the snapshot', () => {
    const pending = toBotRestockPollResponse(botPollRecord());
    const resolved = toBotRestockPollResponse(resolvedRecord());

    for (const key of FORBIDDEN_KEYS) {
      expect(pending).not.toHaveProperty(key);
      expect(resolved).not.toHaveProperty(key);
      expect(pending.snapshot).not.toHaveProperty(key);
      expect(resolved.snapshot).not.toHaveProperty(key);
    }
  });

  it('ignores injected server-only fields and leaks no sentinel value', () => {
    const body = toBotRestockPollResponse(
      withExtraFields(resolvedRecord(), {
        source: 'SOURCE-SENTINEL',
        tenantId: 'TENANT-SECRET',
        canonicalRequestHash: 'HASH-SECRET',
        submittedCredentialId: 'CREDENTIAL-SECRET',
        resolvedById: 'REVIEWER-ID-SECRET',
        resolvedByActorId: 'REVIEWER-ID-SECRET',
        resolvedByDisplayName: 'REVIEWER-NAME-SECRET',
        resolvedBy: {
          id: 'REVIEWER-ID-SECRET',
          displayName: 'REVIEWER-NAME-SECRET',
        },
        resolutionRequestId: 'RESOLUTION-REQUEST-SECRET',
        applicationOutcome: 'PROVIDER_ACCEPTED',
        providerMessageId: 'PROVIDER-MESSAGE-SECRET',
        providerAcceptedObservedAt: 'PROVIDER-OBSERVED-SECRET',
        ackReceivedAt: 'ACK-RECEIVED-SECRET',
        auditReason: 'AUDIT-SECRET',
        customerPhone: 'PHONE-SECRET',
        customerAddress: 'ADDRESS-SECRET',
        transcript: 'TRANSCRIPT-SECRET',
      }),
    );

    const serialized = JSON.stringify(body);
    for (const sentinel of [
      'SOURCE-SENTINEL',
      'TENANT-SECRET',
      'HASH-SECRET',
      'CREDENTIAL-SECRET',
      'REVIEWER-ID-SECRET',
      'REVIEWER-NAME-SECRET',
      'RESOLUTION-REQUEST-SECRET',
      'PROVIDER_ACCEPTED',
      'PROVIDER-MESSAGE-SECRET',
      'PROVIDER-OBSERVED-SECRET',
      'ACK-RECEIVED-SECRET',
      'AUDIT-SECRET',
      'PHONE-SECRET',
      'ADDRESS-SECRET',
      'TRANSCRIPT-SECRET',
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
    expect(body).not.toHaveProperty('source');
  });

  it('ignores an injected resolution on a pending row', () => {
    const pending = toBotRestockPollResponse(
      withExtraFields(botPollRecord(), {
        resolution: {
          action: 'PROVIDE_RESTOCK_ESTIMATE',
          restockDays: 9,
          resolvedBy: { id: 'INJECTED-ID-SENTINEL' },
        },
        applyBefore: 'INJECTED-APPLY-SENTINEL',
      }),
    );

    expect(pending.status).toBe('PENDING');
    expect(pending.resolution).toBeNull();
    expect(pending.applyBefore).toBeNull();
    expect(JSON.stringify(pending)).not.toContain('PROVIDE_RESTOCK_ESTIMATE');
    expect(JSON.stringify(pending)).not.toContain('INJECTED-ID-SENTINEL');
    expect(JSON.stringify(pending)).not.toContain('INJECTED-APPLY-SENTINEL');
  });
});

describe('toBotExpirationPollResponse — exact shape and PENDING', () => {
  it('exposes the exact 10 top-level and 9 EXPIRATION snapshot keys', () => {
    const pending = toBotExpirationPollResponse(expirationPollRecord());
    const resolved = toBotExpirationPollResponse(resolvedExpirationRecord());

    for (const body of [pending, resolved]) {
      expect(Object.keys(body).sort()).toEqual(
        [...EXPECTED_TOP_LEVEL_KEYS].sort(),
      );
      expect(Object.keys(body).length).toBe(10);
    }
    expect(Object.keys(pending.snapshot).sort()).toEqual(
      [...EXPECTED_EXPIRATION_SNAPSHOT_KEYS].sort(),
    );
    expect(pending.snapshot.unit).toBe(EXPIRATION_UNIT);
    expect(pending.snapshot).not.toHaveProperty('productUnit');
  });

  it('narrows the union and reports the current PENDING state', () => {
    const pending: BotExpirationPollResponse = toBotExpirationPollResponse(
      expirationPollRecord(),
    );
    const resolved: BotExpirationPollResponse = toBotExpirationPollResponse(
      resolvedExpirationRecord(),
    );

    expect(pending.type).toBe('EXPIRATION');
    expect(resolved.type).toBe('EXPIRATION');
    expect(pending.id).toBe(DECISION_ID);
    expect(pending.sourceRequestId).toBe(SOURCE_REQUEST_ID);
    expect(pending.status).toBe('PENDING');
    expect(pending.version).toBe(1);
    expect(pending.createdAt).toBe(CREATED_AT_ISO);
    expect(pending.supersedesDecisionId).toBeNull();
    expect(pending.resolution).toBeNull();
    expect(pending.applyBefore).toBeNull();
    expect(resolved.status).toBe('RESOLVED');
    if (resolved.status === 'RESOLVED') {
      expect(resolved.version).toBe(2);
      expect(resolved.applyBefore).toBe(EXPIRATION_APPLY_BEFORE_ISO);
    }
  });
});

describe('toBotExpirationPollResponse — snapshot projection', () => {
  it('projects a simple product with every variant field explicitly null', () => {
    const body = toBotExpirationPollResponse(expirationPollRecord());

    expect(body.snapshot).toEqual({
      branchId: BRANCH_ID,
      branchName: BRANCH_NAME,
      productId: PRODUCT_ID,
      productName: PRODUCT_NAME,
      unit: EXPIRATION_UNIT,
      variantId: null,
      variantName: null,
      variantOption: null,
      variantValue: null,
    });
  });

  it('requires a variant name and allows nullable option/value', () => {
    const variant = toBotExpirationPollResponse(expirationVariantRecord());
    const bare = toBotExpirationPollResponse(
      expirationVariantRecord({
        snapshot: { variantOption: null, variantValue: null },
      }),
    );

    for (const body of [variant, bare]) {
      expect(body.snapshot.variantId).toBe(VARIANT_ID);
      expect(body.snapshot.variantName).toBe(EXPIRATION_VARIANT_NAME);
    }
    expect(variant.snapshot.variantOption).toBe(EXPIRATION_VARIANT_OPTION);
    expect(variant.snapshot.variantValue).toBe(EXPIRATION_VARIANT_VALUE);
    expect(bare.snapshot.variantOption).toBeNull();
    expect(bare.snapshot.variantValue).toBeNull();
  });
});

describe('toBotExpirationPollResponse — RESOLVED projection', () => {
  const unavailable = (): BotExpirationPollResponse =>
    toBotExpirationPollResponse(
      resolvedExpirationRecord({
        resolutionAction: EXPIRATION_NEGATIVE_ACTION,
        expirationText: null,
      }),
    );

  it('projects the provided text with the 24h applyBefore', () => {
    const body = toBotExpirationPollResponse(resolvedExpirationRecord());

    expect(body.status).toBe('RESOLVED');
    expect(body.version).toBe(2);
    expect(body.resolution).toEqual({
      action: EXPIRATION_POSITIVE_ACTION,
      expirationText: EXPIRATION_TEXT,
      resolvedAt: RESOLVED_AT_ISO,
    });
    expect(Object.keys(body.resolution as object).sort()).toEqual(
      ['action', 'expirationText', 'resolvedAt'].sort(),
    );
    expect(body.applyBefore).toBe(EXPIRATION_APPLY_BEFORE_ISO);
  });

  it('omits expirationText entirely for the unavailable action', () => {
    const body = unavailable();

    expect(body.resolution).toEqual({
      action: EXPIRATION_NEGATIVE_ACTION,
      resolvedAt: RESOLVED_AT_ISO,
    });
    expect(body.resolution).not.toHaveProperty('expirationText');
    expect(Object.keys(body.resolution as object).sort()).toEqual([
      'action',
      'resolvedAt',
    ]);
  });

  it('applies the same 24h deadline to both actions, unlike RESTOCK 1h', () => {
    const positive = toBotExpirationPollResponse(resolvedExpirationRecord());

    expect(positive.applyBefore).toBe(EXPIRATION_APPLY_BEFORE_ISO);
    expect(unavailable().applyBefore).toBe(EXPIRATION_APPLY_BEFORE_ISO);
    expect(toBotRestockPollResponse(resolvedRecord()).applyBefore).toBe(
      APPLY_BEFORE_ISO,
    );
  });

  it('normalizes persisted expiration text before projecting it', () => {
    const body = toBotExpirationPollResponse(
      resolvedExpirationRecord({ expirationText: EXPIRATION_UNTRIMMED_TEXT }),
    );

    expect((body.resolution as { expirationText: string }).expirationText).toBe(
      EXPIRATION_TEXT,
    );
  });
});

describe('toBotExpirationPollResponse — fail-closed on malformed EXPIRATION state', () => {
  const resolvedBase: PollOverrides = {
    status: 'RESOLVED',
    version: 2,
    resolutionAction: EXPIRATION_POSITIVE_ACTION,
    expirationText: EXPIRATION_TEXT,
    resolvedAt: utcDate(RESOLVED_AT_ISO),
  };

  it('fails closed on every malformed persisted EXPIRATION shape', () => {
    const rejects = (overrides: PollOverrides): void => {
      expect(() =>
        toBotExpirationPollResponse(expirationPollRecord(overrides)),
      ).toThrow('Malformed persisted bot restock poll state');
    };

    // Type, unit, variant coupling and non-null supersedes.
    rejects({ type: RESTOCK_TYPE });
    rejects({ type: 'SHIPPING' });
    rejects({ snapshot: { productUnit: null } });
    rejects({ snapshot: { productUnit: 7 as unknown as string } });
    rejects({ snapshot: { variantId: VARIANT_ID, variantName: null } });
    rejects({ snapshot: { variantName: EXPIRATION_VARIANT_NAME } });
    rejects({ snapshot: { variantOption: EXPIRATION_VARIANT_OPTION } });
    rejects({ snapshot: { variantValue: EXPIRATION_VARIANT_VALUE } });
    rejects({ supersedesDecisionId: SUPERSEDES_ID });
    // PENDING/RESOLVED version coupling.
    rejects({ status: 'PENDING', version: 2 });
    rejects({
      status: 'PENDING',
      version: 1,
      resolutionAction: EXPIRATION_POSITIVE_ACTION,
    });
    rejects({ status: 'PENDING', version: 1, expirationText: EXPIRATION_TEXT });
    rejects({
      status: 'PENDING',
      version: 1,
      resolvedAt: utcDate(RESOLVED_AT_ISO),
    });
    rejects({ ...resolvedBase, version: 1 });
    rejects({ ...resolvedBase, version: 3 });
    rejects({ ...resolvedBase, resolvedAt: null });
    // Action ownership and expiration-text validity.
    rejects({
      ...resolvedBase,
      resolutionAction: HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE,
    });
    rejects({ ...resolvedBase, resolutionAction: 'BOGUS' });
    rejects({ ...resolvedBase, expirationText: null });
    rejects({ ...resolvedBase, expirationText: '   ' });
    rejects({ ...resolvedBase, expirationText: `Vence${C0_CONTROL}` });
    rejects({ ...resolvedBase, expirationText: 'a'.repeat(501) });
    rejects({ ...resolvedBase, restockDays: RESTOCK_DAYS });
    rejects({ ...resolvedBase, resolutionAction: EXPIRATION_NEGATIVE_ACTION });
    rejects({
      ...resolvedBase,
      resolutionAction: EXPIRATION_NEGATIVE_ACTION,
      expirationText: null,
      restockDays: RESTOCK_DAYS,
    });
    // Shared id/date guards, re-exercised through the EXPIRATION path.
    rejects({ id: '00000000-0000-0000-0000-000000000000' });
    rejects({ id: DECISION_ID.toUpperCase() });
    rejects({ sourceRequestId: '00000000-0000-0000-0000-000000000000' });
    rejects({ createdAt: new Date('invalid') });
    rejects({ ...resolvedBase, resolvedAt: new Date('invalid') });
  });

  it('fails closed when resolvedAt + 24h overflows the Date range', () => {
    const record = resolvedExpirationRecord({
      resolvedAt: new Date(8_640_000_000_000_000),
    });

    expect(() => toBotExpirationPollResponse(record)).toThrow(
      'Malformed persisted bot restock poll state',
    );
  });

  it('throws a value-free error that never echoes persisted values', () => {
    const record = resolvedExpirationRecord({
      resolutionAction: 'BOGUS_ACTION',
      snapshot: {
        productName: 'PRODUCT-NAME-SENTINEL',
        variantName: 'VARIANT-NAME-SENTINEL',
      },
    });

    let message = '';
    try {
      toBotExpirationPollResponse(record);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).not.toBe('');
    expect(message).not.toContain('BOGUS_ACTION');
    expect(message).not.toContain('PRODUCT-NAME-SENTINEL');
    expect(message).not.toContain('VARIANT-NAME-SENTINEL');
    expect(message).not.toContain(DECISION_ID);
  });
});

describe('toBotExpirationPollResponse — no reviewer identity / authority / PII leaks', () => {
  it('omits every forbidden key and ignores injected server-only fields', () => {
    const injected = {
      source: 'SOURCE-SENTINEL',
      tenantId: 'TENANT-SECRET',
      canonicalRequestHash: 'HASH-SECRET',
      submittedCredentialId: 'CREDENTIAL-SECRET',
      resolvedById: 'REVIEWER-ID-SECRET',
      resolvedByDisplayName: 'REVIEWER-NAME-SECRET',
      resolutionRequestId: 'RESOLUTION-REQUEST-SECRET',
      applicationOutcome: 'PROVIDER_ACCEPTED',
      providerMessageId: 'PROVIDER-MESSAGE-SECRET',
      ackReceivedAt: 'ACK-RECEIVED-SECRET',
    };
    const bodies = [
      toBotExpirationPollResponse(
        withExtraFields(expirationPollRecord(), injected),
      ),
      toBotExpirationPollResponse(
        withExtraFields(resolvedExpirationRecord(), injected),
      ),
    ];
    const forbidden = [...FORBIDDEN_KEYS, ...EXPIRATION_FORBIDDEN_KEYS];

    for (const body of bodies) {
      for (const key of forbidden) {
        expect(body).not.toHaveProperty(key);
        expect(body.snapshot).not.toHaveProperty(key);
      }
      const serialized = JSON.stringify(body);
      for (const key of forbidden) {
        expect(serialized).not.toContain(`"${key}"`);
      }
      for (const sentinel of Object.values(injected)) {
        expect(serialized).not.toContain(sentinel);
      }
    }
  });
});
