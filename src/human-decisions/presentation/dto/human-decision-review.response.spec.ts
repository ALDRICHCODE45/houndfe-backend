/**
 * HD-04b1 — HumanDecisionReviewResponse projection spec.
 *
 * Proves the FE-confirmed human reviewer projection is an exact discriminated
 * union with no bot-only/authority/PII leakage, that `allowedActions` follows
 * the caller's `update:HumanDecision` capability (passed as `canResolve`), and
 * that a malformed persisted row fails closed with a value-free `Error` instead
 * of publishing an invalid `status`/`resolution` discriminant.
 *
 * Approved design (read-only):
 * `houndfe-chatbot-human-decisions/docs/human-decisions-contract-v1.md`.
 */
import { RESTOCK_TYPE } from '../../domain/restock-request-canonicalizer';
import {
  toHumanDecisionReviewResponse,
  type HumanDecisionReviewAction,
  type HumanDecisionReviewPendingResponse,
  type HumanDecisionReviewRecord,
  type HumanDecisionReviewResponse,
} from './human-decision-review.response';

const DECISION_ID = '2b7c1a90-6f3e-4d2a-8b1c-0d9e8f7a6b5c';
const CREATED_AT_ISO = '2026-02-01T10:00:00.000Z';
const OBSERVED_AT_ISO = '2026-01-31T23:30:00.000Z';
const RESOLVED_AT_ISO = '2026-02-02T09:15:00.000Z';
const PRODUCT_ID = '8f14e45f-ceea-4e42-9f62-1a2b3c4d5e6f';
const VARIANT_ID = '550e8400-e29b-41d4-a716-446655440000';
const BRANCH_ID = 'branch-1';
const BRANCH_NAME = 'Sucursal Centro';
const PRODUCT_NAME = 'Filtro de aceite';
const SKU = 'SKU-1';
const REQUESTED_QUANTITY = 3;
const OBSERVED_STOCK = 0;
const REVIEWER_ID = 'reviewer-1';
const REVIEWER_NAME = 'Ada Lovelace';
const C0_CONTROL = '\u0000';
const C1_CONTROL = '\u0085';
const NFD_PRODUCT_NAME = 'Cafe\u0301';
const NFD_SKU = 'Sku\u0301';

const EXPECTED_TOP_LEVEL_KEYS = [
  'id',
  'type',
  'title',
  'sanitizedSummary',
  'createdAt',
  'snapshot',
  'status',
  'version',
  'resolution',
  'allowedActions',
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

const EXPECTED_PENDING_ACTIONS = [
  'PROVIDE_RESTOCK_ESTIMATE',
  'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
];

/** Keys that must NEVER appear anywhere on the human reviewer projection. */
const FORBIDDEN_KEYS = [
  'source',
  'tenantId',
  'sourceRequestId',
  'canonicalRequestHash',
  'hash',
  'submittedCredentialId',
  'credentialId',
  'supersedesDecisionId',
  'applyBefore',
  'resolutionRequestId',
  'resolvedById',
  'applicationOutcome',
  'applicationAttemptId',
  'applicationEvidenceHash',
  'applicationEvidenceCode',
  'providerMessageId',
  'providerAcceptedObservedAt',
  'applicationAttemptedAt',
  'ackReceivedAt',
  'updatedAt',
  'canResolve',
  'pii',
  'customerPhone',
  'transcript',
  'rawJson',
];

type DecisionOverrides = Partial<HumanDecisionReviewRecord>;

function utcDate(iso: string): Date {
  return new Date(iso);
}

/** Persisted-row shaped record; every field mirrors an HD-01 column. */
function reviewRecord(
  overrides: DecisionOverrides = {},
): HumanDecisionReviewRecord {
  const record: HumanDecisionReviewRecord = {
    id: DECISION_ID,
    type: RESTOCK_TYPE,
    status: 'PENDING',
    version: 1,
    createdAt: utcDate(CREATED_AT_ISO),
    branchId: BRANCH_ID,
    branchName: BRANCH_NAME,
    productId: PRODUCT_ID,
    productName: PRODUCT_NAME,
    variantId: VARIANT_ID,
    sku: SKU,
    requestedQuantity: REQUESTED_QUANTITY,
    observedStockAtRequest: OBSERVED_STOCK,
    stockObservedAt: utcDate(OBSERVED_AT_ISO),
    resolutionAction: null,
    restockDays: null,
    resolvedAt: null,
    resolvedByActorId: null,
    resolvedByDisplayName: null,
    ...overrides,
  };
  return record;
}

function resolvedRecord(
  overrides: DecisionOverrides = {},
): HumanDecisionReviewRecord {
  return reviewRecord({
    status: 'RESOLVED',
    version: 2,
    resolutionAction: 'PROVIDE_RESTOCK_ESTIMATE',
    restockDays: 5,
    resolvedAt: utcDate(RESOLVED_AT_ISO),
    resolvedByActorId: REVIEWER_ID,
    resolvedByDisplayName: REVIEWER_NAME,
    ...overrides,
  });
}

/** Attaches server-only / mutable columns the mapper must ignore. */
function withExtraFields(
  record: HumanDecisionReviewRecord,
  extras: Record<string, unknown>,
): HumanDecisionReviewRecord {
  return Object.assign(record, extras);
}

describe('toHumanDecisionReviewResponse — exact projection shape', () => {
  it('exposes exactly the human top-level key set while pending', () => {
    const body = toHumanDecisionReviewResponse(reviewRecord(), true);

    expect(Object.keys(body).sort()).toEqual(
      [...EXPECTED_TOP_LEVEL_KEYS].sort(),
    );
  });

  it('exposes exactly the human top-level key set while resolved', () => {
    const body = toHumanDecisionReviewResponse(resolvedRecord(), true);

    expect(Object.keys(body).sort()).toEqual(
      [...EXPECTED_TOP_LEVEL_KEYS].sort(),
    );
  });

  it('exposes exactly the persisted snapshot keys and nullable values', () => {
    const body = toHumanDecisionReviewResponse(
      reviewRecord({
        branchName: null,
        variantId: null,
        sku: null,
        requestedQuantity: null,
        observedStockAtRequest: null,
        stockObservedAt: null,
      }),
      false,
    );

    expect(Object.keys(body.snapshot).sort()).toEqual(
      [...EXPECTED_SNAPSHOT_KEYS].sort(),
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
  });

  it('projects the fixed RESTOCK type and server-owned text', () => {
    const body = toHumanDecisionReviewResponse(reviewRecord(), true);

    expect(body.type).toBe('RESTOCK');
    expect(body.id).toBe(DECISION_ID);
    expect(body.createdAt).toBe(CREATED_AT_ISO);
  });

  it('is assignable to the declared discriminated response type', () => {
    const pending: HumanDecisionReviewResponse = toHumanDecisionReviewResponse(
      reviewRecord(),
      false,
    );
    const resolved: HumanDecisionReviewResponse = toHumanDecisionReviewResponse(
      resolvedRecord(),
      false,
    );

    expect(pending.status).toBe('PENDING');
    expect(resolved.status).toBe('RESOLVED');
  });
});

describe('toHumanDecisionReviewResponse — server-owned title and summary', () => {
  it('returns bounded plain text that never interpolates the product name', () => {
    const body = toHumanDecisionReviewResponse(reviewRecord(), true);

    expect(body.title.trim()).not.toBe('');
    expect(body.sanitizedSummary.trim()).not.toBe('');
    expect(body.title).not.toContain(PRODUCT_NAME);
    expect(body.sanitizedSummary).not.toContain(PRODUCT_NAME);
    expect(body.title).not.toContain('<');
    expect(body.sanitizedSummary).not.toContain('<');
    expect(body.title).not.toContain('{');
    expect(body.sanitizedSummary).not.toContain('{');
    expect(body.title.length).toBeLessThanOrEqual(200);
    expect(body.sanitizedSummary.length).toBeLessThanOrEqual(400);
  });

  it('keeps the sanitized product name only inside the snapshot', () => {
    const body = toHumanDecisionReviewResponse(reviewRecord(), true);

    expect(body.snapshot.productName).toBe(PRODUCT_NAME);
    expect(body).not.toHaveProperty('productName', PRODUCT_NAME);
  });
});

describe('toHumanDecisionReviewResponse — PENDING projection', () => {
  it('returns the pending discriminant with a null resolution', () => {
    const body = toHumanDecisionReviewResponse(reviewRecord(), false);

    expect(body.status).toBe('PENDING');
    expect(body.version).toBe(1);
    expect(body.resolution).toBeNull();
  });

  it('offers the two exact RESTOCK actions in order for a resolver', () => {
    const body = toHumanDecisionReviewResponse(reviewRecord(), true);

    expect(body.allowedActions).toEqual(EXPECTED_PENDING_ACTIONS);
  });

  it('withholds actions for a read-only reviewer even though the row is readable', () => {
    const body = toHumanDecisionReviewResponse(reviewRecord(), false);

    expect(body.allowedActions).toEqual([]);
  });

  it('returns a fresh allowedActions array per call', () => {
    const first = toHumanDecisionReviewResponse(reviewRecord(), true);
    const second = toHumanDecisionReviewResponse(reviewRecord(), true);

    expect(first.allowedActions).not.toBe(second.allowedActions);
    expect(first.allowedActions).toEqual(second.allowedActions);
  });

  it('never fabricates a resolution for a pending decision', () => {
    const body = toHumanDecisionReviewResponse(reviewRecord(), true);

    expect(body.resolution).toBeNull();
    expect(body).not.toHaveProperty('resolutionAction');
    expect(body).not.toHaveProperty('restockDays');
    expect(body).not.toHaveProperty('resolvedAt');
    expect(body).not.toHaveProperty('resolvedBy');
  });
});

describe('toHumanDecisionReviewResponse — RESOLVED projection', () => {
  it('projects the positive estimate variant with days and reviewer', () => {
    const body = toHumanDecisionReviewResponse(resolvedRecord(), true);

    expect(body.status).toBe('RESOLVED');
    expect(body.version).toBe(2);
    expect(body.allowedActions).toEqual([]);
    expect(body.resolution).toEqual({
      action: 'PROVIDE_RESTOCK_ESTIMATE',
      restockDays: 5,
      resolvedAt: RESOLVED_AT_ISO,
      resolvedBy: { id: REVIEWER_ID, displayName: REVIEWER_NAME },
    });
  });

  it('projects the negative variant and OMITS restockDays entirely', () => {
    const body = toHumanDecisionReviewResponse(
      resolvedRecord({
        resolutionAction: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
        restockDays: null,
      }),
      true,
    );

    expect(body.resolution).toEqual({
      action: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
      resolvedAt: RESOLVED_AT_ISO,
      resolvedBy: { id: REVIEWER_ID, displayName: REVIEWER_NAME },
    });
    expect(body.resolution).not.toHaveProperty('restockDays');
    expect(body.resolution && 'restockDays' in body.resolution).toBe(false);
  });

  it('always clears actions once resolved regardless of canResolve', () => {
    const body = toHumanDecisionReviewResponse(resolvedRecord(), true);

    expect(body.allowedActions).toEqual([]);
  });

  it('supports the minimum and maximum positive day boundaries', () => {
    const oneDay = toHumanDecisionReviewResponse(
      resolvedRecord({ restockDays: 1 }),
      false,
    );
    const maxDays = toHumanDecisionReviewResponse(
      resolvedRecord({ restockDays: 365 }),
      false,
    );

    expect(oneDay.resolution).toMatchObject({
      action: 'PROVIDE_RESTOCK_ESTIMATE',
      restockDays: 1,
    });
    expect(maxDays.resolution).toMatchObject({
      action: 'PROVIDE_RESTOCK_ESTIMATE',
      restockDays: 365,
    });
  });
});

describe('toHumanDecisionReviewResponse — durable reviewer snapshots', () => {
  it('projects the immutable snapshots even after the User FK is nulled', () => {
    const body = toHumanDecisionReviewResponse(
      withExtraFields(resolvedRecord(), { resolvedById: null }),
      false,
    );

    expect(body.resolution).toMatchObject({
      resolvedBy: { id: REVIEWER_ID, displayName: REVIEWER_NAME },
    });
  });

  it('never reads the mutable resolvedById relation instead of the snapshots', () => {
    const body = toHumanDecisionReviewResponse(
      withExtraFields(resolvedRecord(), {
        resolvedById: 'RELATION-ID-SENTINEL',
        resolvedByActorId: REVIEWER_ID,
        resolvedByDisplayName: REVIEWER_NAME,
      }),
      false,
    );

    expect(body.resolution).toMatchObject({
      resolvedBy: { id: REVIEWER_ID, displayName: REVIEWER_NAME },
    });
    expect(JSON.stringify(body)).not.toContain('RELATION-ID-SENTINEL');
    expect(body).not.toHaveProperty('resolvedById');
  });
});

describe('toHumanDecisionReviewResponse — UTC ISO date projection', () => {
  it('normalizes createdAt, resolvedAt and stockObservedAt to UTC ISO', () => {
    const body = toHumanDecisionReviewResponse(
      resolvedRecord({
        createdAt: utcDate('2026-02-01T12:00:00+02:00'),
        resolvedAt: utcDate('2026-02-02T11:15:00+02:00'),
        stockObservedAt: utcDate('2026-01-31T23:30:00+02:00'),
      }),
      false,
    );

    expect(body.createdAt).toBe('2026-02-01T10:00:00.000Z');
    expect(body.snapshot.stockObservedAt).toBe('2026-01-31T21:30:00.000Z');
    expect(body.resolution).toMatchObject({
      resolvedAt: '2026-02-02T09:15:00.000Z',
    });
    const resolvedAtIso = body.resolution?.resolvedAt ?? '';
    expect(resolvedAtIso).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(body.createdAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it('projects a null stockObservedAt without dropping any snapshot key', () => {
    const body = toHumanDecisionReviewResponse(
      reviewRecord({ observedStockAtRequest: null, stockObservedAt: null }),
      false,
    );

    expect(body.snapshot.stockObservedAt).toBeNull();
    expect(Object.keys(body.snapshot).sort()).toEqual(
      [...EXPECTED_SNAPSHOT_KEYS].sort(),
    );
  });
});

describe('toHumanDecisionReviewResponse — purity', () => {
  it('does not mutate the input record or its dates', () => {
    const createdAt = utcDate(CREATED_AT_ISO);
    const stockObservedAt = utcDate(OBSERVED_AT_ISO);
    const record = reviewRecord({ createdAt, stockObservedAt });
    const snapshotValues = JSON.parse(JSON.stringify(record)) as unknown;
    const createdTime = createdAt.getTime();
    const observedTime = stockObservedAt.getTime();

    toHumanDecisionReviewResponse(record, true);

    expect(createdAt.getTime()).toBe(createdTime);
    expect(stockObservedAt.getTime()).toBe(observedTime);
    expect(record.createdAt).toBe(createdAt);
    expect(record.stockObservedAt).toBe(stockObservedAt);
    expect(JSON.parse(JSON.stringify(record))).toEqual(snapshotValues);
  });

  it('maps a frozen input without throwing', () => {
    const record = resolvedRecord();
    Object.freeze(record);

    expect(() => toHumanDecisionReviewResponse(record, true)).not.toThrow();
  });
});

describe('toHumanDecisionReviewResponse — fail-closed on invalid persisted state', () => {
  const invalidRecords: Array<[string, HumanDecisionReviewRecord]> = [
    [
      'an unknown resolution action',
      resolvedRecord({ resolutionAction: 'BOGUS_ACTION' }),
    ],
    [
      'a null resolution action while resolved',
      resolvedRecord({ resolutionAction: null }),
    ],
    ['missing positive days', resolvedRecord({ restockDays: null })],
    ['zero positive days', resolvedRecord({ restockDays: 0 })],
    ['negative positive days', resolvedRecord({ restockDays: -3 })],
    ['days above the contract range', resolvedRecord({ restockDays: 366 })],
    ['non-integer positive days', resolvedRecord({ restockDays: 2.5 })],
    [
      'days on the negative action',
      resolvedRecord({
        resolutionAction: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
        restockDays: 4,
      }),
    ],
    ['a missing resolvedAt', resolvedRecord({ resolvedAt: null })],
    [
      'a missing reviewer actor snapshot',
      resolvedRecord({ resolvedByActorId: null }),
    ],
    [
      'a missing reviewer display snapshot',
      resolvedRecord({ resolvedByDisplayName: null }),
    ],
    ['a resolved row pinned to version 1', resolvedRecord({ version: 1 })],
    ['a resolved row pinned to version 3', resolvedRecord({ version: 3 })],
    ['a pending row pinned to version 2', reviewRecord({ version: 2 })],
    [
      'a pending row carrying a resolution action',
      reviewRecord({ resolutionAction: 'PROVIDE_RESTOCK_ESTIMATE' }),
    ],
    ['a pending row carrying restock days', reviewRecord({ restockDays: 5 })],
    ['an unknown status', reviewRecord({ status: 'EXPIRED' })],
  ];

  it.each(invalidRecords)('rejects %s', (_label, record) => {
    expect(() => toHumanDecisionReviewResponse(record, true)).toThrow(Error);
  });

  it('throws a value-free error that never echoes persisted values', () => {
    const record = resolvedRecord({
      resolutionAction: 'BOGUS_ACTION',
      productName: 'PRODUCT-NAME-SENTINEL',
      resolvedByDisplayName: 'REVIEWER-SENTINEL',
    });

    let message = '';
    try {
      toHumanDecisionReviewResponse(record, true);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).not.toBe('');
    expect(message).not.toContain('BOGUS_ACTION');
    expect(message).not.toContain('PRODUCT-NAME-SENTINEL');
    expect(message).not.toContain('REVIEWER-SENTINEL');
    expect(message).not.toContain(REVIEWER_ID);
  });
});

describe('toHumanDecisionReviewResponse — no bot/authority/PII leaks', () => {
  it('omits every forbidden key from the projection', () => {
    const pending = toHumanDecisionReviewResponse(reviewRecord(), true);
    const resolved = toHumanDecisionReviewResponse(resolvedRecord(), false);

    for (const key of FORBIDDEN_KEYS) {
      expect(pending).not.toHaveProperty(key);
      expect(resolved).not.toHaveProperty(key);
      expect(pending.snapshot).not.toHaveProperty(key);
      expect(resolved.snapshot).not.toHaveProperty(key);
    }
  });

  it('ignores injected server-only fields and leaks no sentinel value', () => {
    const body = toHumanDecisionReviewResponse(
      withExtraFields(resolvedRecord(), {
        source: 'houndfe-chatbot',
        tenantId: 'TENANT-SECRET',
        sourceRequestId: 'SOURCE-REQUEST-SECRET',
        canonicalRequestHash: 'HASH-SECRET',
        submittedCredentialId: 'CREDENTIAL-SECRET',
        supersedesDecisionId: 'SUPERSEDES-SECRET',
        applyBefore: 'APPLY-BEFORE-SECRET',
        resolutionRequestId: 'RESOLUTION-REQUEST-SECRET',
        applicationOutcome: 'PROVIDER_ACCEPTED',
        applicationAttemptId: 'ATTEMPT-SECRET',
        applicationEvidenceHash: 'EVIDENCE-HASH-SECRET',
        applicationEvidenceCode: 'EVIDENCE-CODE-SECRET',
        providerMessageId: 'PROVIDER-MESSAGE-SECRET',
        providerAcceptedObservedAt: 'PROVIDER-OBSERVED-SECRET',
        applicationAttemptedAt: 'ATTEMPTED-AT-SECRET',
        ackReceivedAt: 'ACK-RECEIVED-SECRET',
        updatedAt: 'UPDATED-AT-SECRET',
        pii: 'PII-SECRET',
        customerPhone: 'PHONE-SECRET',
        transcript: 'TRANSCRIPT-SECRET',
        rawJson: 'RAW-JSON-SECRET',
      }),
      true,
    );

    const serialized = JSON.stringify(body);
    for (const sentinel of [
      'houndfe-chatbot',
      'TENANT-SECRET',
      'SOURCE-REQUEST-SECRET',
      'HASH-SECRET',
      'CREDENTIAL-SECRET',
      'SUPERSEDES-SECRET',
      'APPLY-BEFORE-SECRET',
      'RESOLUTION-REQUEST-SECRET',
      'PROVIDER_ACCEPTED',
      'ATTEMPT-SECRET',
      'EVIDENCE-HASH-SECRET',
      'EVIDENCE-CODE-SECRET',
      'PROVIDER-MESSAGE-SECRET',
      'PROVIDER-OBSERVED-SECRET',
      'ATTEMPTED-AT-SECRET',
      'ACK-RECEIVED-SECRET',
      'UPDATED-AT-SECRET',
      'PII-SECRET',
      'PHONE-SECRET',
      'TRANSCRIPT-SECRET',
      'RAW-JSON-SECRET',
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it('ignores an injected resolution on a pending row', () => {
    const pending = toHumanDecisionReviewResponse(
      withExtraFields(reviewRecord(), {
        resolution: {
          action: 'PROVIDE_RESTOCK_ESTIMATE',
          restockDays: 9,
          resolvedBy: {
            id: 'INJECTED-ID-SENTINEL',
            displayName: 'INJECTED-NAME-SENTINEL',
          },
        },
      }),
      false,
    );

    expect(pending.status).toBe('PENDING');
    expect(pending.resolution).toBeNull();
    expect(pending.allowedActions).toEqual([]);
    expect(JSON.stringify(pending)).not.toContain('PROVIDE_RESTOCK_ESTIMATE');
    expect(JSON.stringify(pending)).not.toContain('INJECTED-ID-SENTINEL');
    expect(JSON.stringify(pending)).not.toContain('INJECTED-NAME-SENTINEL');
  });
});

describe('toHumanDecisionReviewResponse — persisted type discriminant', () => {
  it('fails closed when the persisted type is not RESTOCK', () => {
    expect(() =>
      toHumanDecisionReviewResponse(reviewRecord({ type: 'SHIPPING' }), true),
    ).toThrow(Error);
  });

  it('never echoes the wrong persisted type in the error', () => {
    let message = '';
    try {
      toHumanDecisionReviewResponse(
        reviewRecord({ type: 'SHIPPING-TYPE-SENTINEL' }),
        true,
      );
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).not.toBe('');
    expect(message).not.toContain('SHIPPING-TYPE-SENTINEL');
  });
});

/**
 * Compile-time guards: each alias resolves to `never` if the bad action shape
 * were accepted by the DTO field. Widening the field would therefore fail to
 * compile the `true` literals below, so the type can never drift back to a
 * generic `string[]`.
 */
type ReorderedActionsRejected = [
  'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
  'PROVIDE_RESTOCK_ESTIMATE',
] extends HumanDecisionReviewPendingResponse['allowedActions']
  ? never
  : true;
type PartialActionsRejected = [
  'PROVIDE_RESTOCK_ESTIMATE',
] extends HumanDecisionReviewPendingResponse['allowedActions']
  ? never
  : true;
type WidenedActionsRejected =
  HumanDecisionReviewAction[] extends HumanDecisionReviewPendingResponse['allowedActions']
    ? never
    : true;

describe('toHumanDecisionReviewResponse — exact pending action typing', () => {
  it('accepts only the empty array or the exact ordered action pair', () => {
    const reorderedRejected: ReorderedActionsRejected = true;
    const partialRejected: PartialActionsRejected = true;
    const widenedRejected: WidenedActionsRejected = true;
    const exact: HumanDecisionReviewPendingResponse['allowedActions'] = [
      'PROVIDE_RESTOCK_ESTIMATE',
      'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
    ];
    const empty: HumanDecisionReviewPendingResponse['allowedActions'] = [];

    expect(reorderedRejected).toBe(true);
    expect(partialRejected).toBe(true);
    expect(widenedRejected).toBe(true);
    expect(exact).toEqual(EXPECTED_PENDING_ACTIONS);
    expect(empty).toEqual([]);
  });
});

describe('toHumanDecisionReviewResponse — snapshot invariant fail-closed', () => {
  const invalidSnapshots: Array<[string, DecisionOverrides]> = [
    ['an empty product name', { productName: '' }],
    ['a whitespace-only product name', { productName: '   ' }],
    ['a non-NFC product name', { productName: NFD_PRODUCT_NAME }],
    ['an untrimmed product name', { productName: ` ${PRODUCT_NAME} ` }],
    ['a collapsed-space product name', { productName: 'Filtro  de aceite' }],
    ['an over-long product name', { productName: 'a'.repeat(201) }],
    ['a C0-control product name', { productName: `Filtro${C0_CONTROL}aceite` }],
    ['a C1-control product name', { productName: `Filtro${C1_CONTROL}aceite` }],
    ['an untrimmed sku', { sku: ` ${SKU} ` }],
    ['a non-NFC sku', { sku: NFD_SKU }],
    ['a blank sku', { sku: '' }],
    ['a C0-control sku', { sku: `SKU${C0_CONTROL}` }],
    ['a C1-control sku', { sku: `SKU${C1_CONTROL}` }],
    ['a zero requested quantity', { requestedQuantity: 0 }],
    ['a negative requested quantity', { requestedQuantity: -2 }],
    ['a fractional requested quantity', { requestedQuantity: 1.5 }],
    [
      'an unsafe requested quantity',
      { requestedQuantity: Number.MAX_SAFE_INTEGER + 1 },
    ],
    ['a negative observed stock', { observedStockAtRequest: -1 }],
    ['a fractional observed stock', { observedStockAtRequest: 0.5 }],
    [
      'an observation count without a timestamp',
      { observedStockAtRequest: 4, stockObservedAt: null },
    ],
    [
      'an observation timestamp without a count',
      {
        observedStockAtRequest: null,
        stockObservedAt: utcDate(OBSERVED_AT_ISO),
      },
    ],
    ['an invalid observed timestamp', { stockObservedAt: new Date('invalid') }],
    ['an invalid createdAt', { createdAt: new Date('invalid') }],
    ['an invalid product UUID', { productId: 'not-a-uuid' }],
    ['an invalid variant UUID', { variantId: 'not-a-uuid' }],
  ];

  it.each(invalidSnapshots)(
    'rejects a persisted row with %s',
    (_label, overrides) => {
      expect(() =>
        toHumanDecisionReviewResponse(reviewRecord(overrides), true),
      ).toThrow(Error);
    },
  );

  it('rejects a resolved reviewer with a blank actor snapshot', () => {
    expect(() =>
      toHumanDecisionReviewResponse(
        resolvedRecord({ resolvedByActorId: '  ' }),
        true,
      ),
    ).toThrow(Error);
  });

  it('rejects a resolved reviewer with a blank display snapshot', () => {
    expect(() =>
      toHumanDecisionReviewResponse(
        resolvedRecord({ resolvedByDisplayName: '' }),
        true,
      ),
    ).toThrow(Error);
  });

  it('rejects an invalid resolvedAt before any ISO conversion', () => {
    expect(() =>
      toHumanDecisionReviewResponse(
        resolvedRecord({ resolvedAt: new Date('invalid') }),
        true,
      ),
    ).toThrow(Error);
  });

  it('keeps every snapshot error value-free', () => {
    let message = '';
    try {
      toHumanDecisionReviewResponse(reviewRecord({ productName: '' }), true);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).not.toBe('');
    expect(message).not.toContain(PRODUCT_NAME);
  });
});
