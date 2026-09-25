/**
 * HD-05c1 — BotApplicationOutcomeResponse projection spec.
 *
 * Proves the bot terminal-ACK success body (first commit AND exact replay) is
 * EXACTLY five top-level keys `{id,version:2,attemptId,outcome,ackReceivedAt}`
 * and nothing else. There is NO sixth key: the `NEEDS_RECONCILIATION` hold for
 * `PROVIDER_ACCEPTED_LATE` and `DELIVERY_UNKNOWN` is signalled by the `outcome`
 * discriminant ALONE, never by an extra flag.
 *
 * The mapper is a pure function over the committed
 * `BotApplicationOutcomeAcknowledgment`: it converts the backend
 * `ackReceivedAt` `Date` (the RECEIPT clock, not the bot-observed provider
 * timestamp) to canonical UTC ISO, reads ONLY the five allowlisted keys with no
 * spread, and never mutates the input.
 *
 * Deliberately ABSENT (authority / provider evidence / PII): `decisionId`,
 * `tenantId`, `source`, `credentialId`, `submittedCredentialId`,
 * `canonicalRequestHash`, `applicationEvidenceHash`, `providerMessageId`,
 * `providerAcceptedObservedAt`, `attemptedAt`, `evidenceCode`, reviewer
 * identity, customer PII, `needsReconciliation`/`hold` flags. A malformed
 * persisted acknowledgment (nil/uppercase UUID, wrong version or outcome, an
 * invalid `Date`) fails closed with one value-free constant error.
 */
import {
  DELIVERY_UNKNOWN,
  PROVIDER_ACCEPTED,
  PROVIDER_ACCEPTED_LATE,
  STALE,
} from '../../domain/bot-application-outcome.request';
import type { BotApplicationOutcomeAcknowledgment } from '../../domain/bot-application-outcome.repository';
import {
  toBotApplicationOutcomeResponse,
  type BotApplicationOutcomeResponse,
} from './bot-application-outcome.response';

const DECISION_ID = '2b7c1a90-6f3e-4d2a-8b1c-0d9e8f7a6b5c';
const ATTEMPT_ID = '3f1c1b7a-9c2e-4d5f-8a6b-1c2d3e4f5a6b';
const ACK_AT_ISO = '2026-02-01T10:00:00.000Z';

/** The exact five-key bot ACK body. */
const EXPECTED_TOP_LEVEL_KEYS = [
  'id',
  'version',
  'attemptId',
  'outcome',
  'ackReceivedAt',
];

/** Keys that must NEVER appear on the bot ACK body (authority/provider/PII). */
const FORBIDDEN_KEYS = [
  'decisionId',
  'tenantId',
  'source',
  'type',
  'status',
  'credentialId',
  'submittedCredentialId',
  'canonicalRequestHash',
  'applicationEvidenceHash',
  'applicationAttemptId',
  'applicationOutcome',
  'applicationAttemptedAt',
  'applicationEvidenceCode',
  'providerMessageId',
  'providerAcceptedObservedAt',
  'attemptedAt',
  'evidenceCode',
  'ackReceivedAtRaw',
  'resolvedAt',
  'resolvedBy',
  'resolvedByActorId',
  'resolvedByDisplayName',
  'reviewer',
  'reviewerId',
  'allowedActions',
  'needsReconciliation',
  'needsReconciliationFlag',
  'hold',
  'reconciliation',
  'pii',
  'customerPhone',
  'customerAddress',
  'transcript',
  'updatedAt',
  'audit',
  'auditReason',
];

/** Unchecked overrides used to build malformed persisted acknowledgments. */
interface RawAckOverrides {
  id?: unknown;
  version?: unknown;
  attemptId?: unknown;
  outcome?: unknown;
  ackReceivedAt?: unknown;
}

const MALFORMED_MESSAGE =
  'Malformed persisted bot application outcome acknowledgment';

/** A well-formed committed acknowledgment; overrides stay unchecked on purpose. */
function ack(
  overrides: RawAckOverrides = {},
): BotApplicationOutcomeAcknowledgment {
  return {
    id: DECISION_ID,
    version: 2,
    attemptId: ATTEMPT_ID,
    outcome: PROVIDER_ACCEPTED,
    ackReceivedAt: new Date(ACK_AT_ISO),
    ...overrides,
  } as unknown as BotApplicationOutcomeAcknowledgment;
}

/** Attaches server-only / authority fields the mapper must ignore. */
function withExtraFields(
  acknowledgment: BotApplicationOutcomeAcknowledgment,
  extras: Record<string, unknown>,
): BotApplicationOutcomeAcknowledgment {
  return Object.assign(acknowledgment, extras);
}

describe('toBotApplicationOutcomeResponse — exact shape', () => {
  it('exposes exactly the five bot-safe top-level keys', () => {
    const body = toBotApplicationOutcomeResponse(ack());

    expect(Object.keys(body).sort()).toEqual(
      [...EXPECTED_TOP_LEVEL_KEYS].sort(),
    );
    expect(Object.keys(body).length).toBe(5);
  });

  it('pins the literal version 2 and reports the outcome verbatim', () => {
    const body: BotApplicationOutcomeResponse =
      toBotApplicationOutcomeResponse(ack());

    expect(body.version).toBe(2);
    expect(body.id).toBe(DECISION_ID);
    expect(body.attemptId).toBe(ATTEMPT_ID);
    expect(body.outcome).toBe(PROVIDER_ACCEPTED);
    expect(body.ackReceivedAt).toBe(ACK_AT_ISO);
  });

  it.each([
    [PROVIDER_ACCEPTED],
    [PROVIDER_ACCEPTED_LATE],
    [DELIVERY_UNKNOWN],
    [STALE],
  ])('keeps exactly five keys for outcome %s', (outcome) => {
    const body = toBotApplicationOutcomeResponse(
      ack({ outcome: outcome as unknown as string }),
    );

    expect(Object.keys(body).sort()).toEqual(
      [...EXPECTED_TOP_LEVEL_KEYS].sort(),
    );
    expect(body.outcome).toBe(outcome);
  });
});

describe('toBotApplicationOutcomeResponse — ackReceivedAt UTC projection', () => {
  it('converts an offset Date to canonical UTC ISO', () => {
    const body = toBotApplicationOutcomeResponse(
      ack({ ackReceivedAt: new Date('2026-02-01T20:30:00+01:00') }),
    );

    expect(body.ackReceivedAt).toBe('2026-02-01T19:30:00.000Z');
  });

  it('converts a negative offset Date to canonical UTC ISO', () => {
    const body = toBotApplicationOutcomeResponse(
      ack({ ackReceivedAt: new Date('2026-02-01T05:00:00-05:00') }),
    );

    expect(body.ackReceivedAt).toBe('2026-02-01T10:00:00.000Z');
  });

  it('preserves an already-canonical UTC instant', () => {
    const body = toBotApplicationOutcomeResponse(ack());

    expect(body.ackReceivedAt).toBe(ACK_AT_ISO);
    expect(body.ackReceivedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });
});

describe('toBotApplicationOutcomeResponse — reconciliation hold is outcome-only', () => {
  it.each([[PROVIDER_ACCEPTED_LATE], [DELIVERY_UNKNOWN]])(
    'signals the hold through outcome %s with no extra flag',
    (outcome) => {
      const body = toBotApplicationOutcomeResponse(
        ack({ outcome: outcome as unknown as string }),
      );

      expect(body.outcome).toBe(outcome);
      expect(body).not.toHaveProperty('needsReconciliation');
      expect(body).not.toHaveProperty('needsReconciliationFlag');
      expect(body).not.toHaveProperty('hold');
      expect(body).not.toHaveProperty('reconciliation');
      expect(JSON.stringify(body)).not.toContain('NEEDS_RECONCILIATION');
      expect(Object.keys(body)).toHaveLength(5);
    },
  );

  it('never adds a hold flag for a definite acceptance', () => {
    const body = toBotApplicationOutcomeResponse(ack());

    expect(body).not.toHaveProperty('needsReconciliation');
    expect(body).not.toHaveProperty('hold');
    expect(Object.keys(body)).toHaveLength(5);
  });
});

describe('toBotApplicationOutcomeResponse — idempotent replay', () => {
  it('returns an identical body for the same persisted data', () => {
    const first = toBotApplicationOutcomeResponse(ack());
    const second = toBotApplicationOutcomeResponse(ack());

    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('returns an identical body across repeated calls on one acknowledgment', () => {
    const acknowledgment = ack({ outcome: DELIVERY_UNKNOWN });

    expect(toBotApplicationOutcomeResponse(acknowledgment)).toEqual(
      toBotApplicationOutcomeResponse(acknowledgment),
    );
  });
});

describe('toBotApplicationOutcomeResponse — no authority/provider/PII leaks', () => {
  it('omits every forbidden key from the top level', () => {
    const body = toBotApplicationOutcomeResponse(ack());

    for (const key of FORBIDDEN_KEYS) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it('ignores injected server-only fields and leaks no sentinel value', () => {
    const body = toBotApplicationOutcomeResponse(
      withExtraFields(ack(), {
        decisionId: 'DECISION-SECRET',
        tenantId: 'TENANT-SECRET',
        source: 'SOURCE-SENTINEL',
        type: 'SHIPPING',
        status: 'RESOLVED',
        credentialId: 'CREDENTIAL-SECRET',
        submittedCredentialId: 'CREDENTIAL-SECRET',
        canonicalRequestHash: 'HASH-SECRET',
        applicationEvidenceHash: 'HASH-SECRET',
        providerMessageId: 'PROVIDER-MESSAGE-SECRET',
        providerAcceptedObservedAt: 'PROVIDER-OBSERVED-SECRET',
        attemptedAt: 'ATTEMPTED-AT-SECRET',
        evidenceCode: 'EVIDENCE-CODE-SECRET',
        needsReconciliation: true,
        hold: 'RECONCILIATION-HOLD-SECRET',
        resolvedByActorId: 'REVIEWER-ID-SECRET',
        resolvedByDisplayName: 'REVIEWER-NAME-SECRET',
        customerPhone: 'PHONE-SECRET',
        customerAddress: 'ADDRESS-SECRET',
        transcript: 'TRANSCRIPT-SECRET',
        auditReason: 'AUDIT-SECRET',
      }),
    );

    expect(Object.keys(body).sort()).toEqual(
      [...EXPECTED_TOP_LEVEL_KEYS].sort(),
    );
    const serialized = JSON.stringify(body);
    for (const sentinel of [
      'DECISION-SECRET',
      'TENANT-SECRET',
      'SOURCE-SENTINEL',
      'CREDENTIAL-SECRET',
      'HASH-SECRET',
      'PROVIDER-MESSAGE-SECRET',
      'PROVIDER-OBSERVED-SECRET',
      'ATTEMPTED-AT-SECRET',
      'EVIDENCE-CODE-SECRET',
      'RECONCILIATION-HOLD-SECRET',
      'REVIEWER-ID-SECRET',
      'REVIEWER-NAME-SECRET',
      'PHONE-SECRET',
      'ADDRESS-SECRET',
      'TRANSCRIPT-SECRET',
      'AUDIT-SECRET',
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
    expect(body).not.toHaveProperty('needsReconciliation');
    expect(body).not.toHaveProperty('source');
  });
});

describe('toBotApplicationOutcomeResponse — fail-closed on malformed state', () => {
  const invalidAcknowledgments: Array<[string, RawAckOverrides]> = [
    ['a nil decision UUID', { id: '00000000-0000-0000-0000-000000000000' }],
    ['an uppercase decision UUID', { id: DECISION_ID.toUpperCase() }],
    ['a non-UUID decision id', { id: 'not-a-uuid' }],
    ['an empty decision id', { id: '' }],
    ['a non-string decision id', { id: 12345 }],
    ['a missing decision id', { id: undefined }],
    [
      'a nil attempt UUID',
      { attemptId: '00000000-0000-0000-0000-000000000000' },
    ],
    ['an uppercase attempt UUID', { attemptId: ATTEMPT_ID.toUpperCase() }],
    ['a non-UUID attempt id', { attemptId: 'attempt-1' }],
    ['a non-string attempt id', { attemptId: { value: ATTEMPT_ID } }],
    [
      'a version below the pinned resolved version (PENDING cannot ACK)',
      { version: 1 },
    ],
    ['a version above the pinned resolved version', { version: 3 }],
    ['a stringly-typed version', { version: '2' }],
    ['a null version', { version: null }],
    ['a missing version', { version: undefined }],
    ['an unknown outcome', { outcome: 'BOGUS' }],
    ['a lowercased outcome', { outcome: 'provider_accepted' }],
    ['a padded outcome', { outcome: ` ${PROVIDER_ACCEPTED} ` }],
    ['a null outcome', { outcome: null }],
    ['an undefined outcome', { outcome: undefined }],
    ['an injected hold outcome', { outcome: 'NEEDS_RECONCILIATION' }],
    ['an invalid ackReceivedAt Date', { ackReceivedAt: new Date('invalid') }],
    ['a stringly-typed ackReceivedAt', { ackReceivedAt: ACK_AT_ISO }],
    ['a numeric ackReceivedAt', { ackReceivedAt: 0 }],
    ['a null ackReceivedAt', { ackReceivedAt: null }],
    ['an undefined ackReceivedAt', { ackReceivedAt: undefined }],
  ];

  it.each(invalidAcknowledgments)(
    'rejects a persisted acknowledgment with %s',
    (_label, overrides) => {
      expect(() => toBotApplicationOutcomeResponse(ack(overrides))).toThrow(
        MALFORMED_MESSAGE,
      );
    },
  );

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an array', []],
    ['a string', 'acknowledgment'],
    ['a number', 7],
  ])('rejects a non-record acknowledgment (%s)', (_label, value) => {
    expect(() =>
      toBotApplicationOutcomeResponse(
        value as unknown as BotApplicationOutcomeAcknowledgment,
      ),
    ).toThrow(MALFORMED_MESSAGE);
  });

  it('throws exactly one constant, value-free error', () => {
    let captured: unknown;
    try {
      toBotApplicationOutcomeResponse(
        ack({
          id: 'ID-SENTINEL',
          attemptId: 'ATTEMPT-SENTINEL',
          version: 99,
          outcome: 'OUTCOME-SENTINEL',
          ackReceivedAt: new Date('invalid'),
        }),
      );
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(Error);
    const error = captured as Error;
    expect(error.message).toBe(MALFORMED_MESSAGE);
    for (const sentinel of [
      'ID-SENTINEL',
      'ATTEMPT-SENTINEL',
      '99',
      'OUTCOME-SENTINEL',
      'Invalid Date',
    ]) {
      expect(error.message).not.toContain(sentinel);
    }
  });
});

describe('toBotApplicationOutcomeResponse — hostile access hardening', () => {
  /** Asserts the mapper failed closed with the one constant, secret-free error. */
  function expectConstantError(
    run: () => unknown,
    secrets: readonly string[] = [],
  ): void {
    let message = '';
    try {
      run();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(MALFORMED_MESSAGE);
    for (const secret of secrets) {
      expect(message).not.toContain(secret);
    }
  }

  function withThrowingGetter(
    key: 'id' | 'attemptId' | 'outcome' | 'ackReceivedAt',
    secret: string,
  ): BotApplicationOutcomeAcknowledgment {
    const acknowledgment = ack();
    Object.defineProperty(acknowledgment, key, {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error(secret);
      },
    });
    return acknowledgment;
  }

  it('never lets a throwing `id` getter escape', () => {
    const secret = 'ID-GETTER-SECRET';
    expectConstantError(
      () => toBotApplicationOutcomeResponse(withThrowingGetter('id', secret)),
      [secret],
    );
  });

  it('never lets a throwing `outcome` getter escape', () => {
    const secret = 'OUTCOME-GETTER-SECRET';
    expectConstantError(
      () =>
        toBotApplicationOutcomeResponse(withThrowingGetter('outcome', secret)),
      [secret],
    );
  });

  it('never lets a throwing `ackReceivedAt` getter escape', () => {
    const secret = 'ACK-GETTER-SECRET';
    expectConstantError(
      () =>
        toBotApplicationOutcomeResponse(
          withThrowingGetter('ackReceivedAt', secret),
        ),
      [secret],
    );
  });

  it('fails closed on a revoked Proxy acknowledgment', () => {
    const { proxy, revoke } = Proxy.revocable(ack(), {});
    revoke();

    expectConstantError(() => toBotApplicationOutcomeResponse(proxy));
  });

  it('fails closed when a Proxy `get` trap throws a sensitive message', () => {
    const secret = 'PROXY-GET-SECRET';
    const hostile = new Proxy(ack(), {
      get() {
        throw new Error(secret);
      },
    });

    expectConstantError(
      () => toBotApplicationOutcomeResponse(hostile),
      [secret],
    );
  });

  it('never lets a hostile `Date` subclass override throw', () => {
    class ThrowingDate extends Date {
      getTime(): number {
        throw new Error('DATE-GETTIME-SECRET');
      }

      toISOString(): string {
        throw new Error('DATE-TOISO-SECRET');
      }
    }
    const hostile = new ThrowingDate('invalid');

    expectConstantError(
      () => toBotApplicationOutcomeResponse(ack({ ackReceivedAt: hostile })),
      ['DATE-GETTIME-SECRET', 'DATE-TOISO-SECRET'],
    );
  });

  it('reads a valid `Date` subclass through the built-in accessors', () => {
    class SneakyDate extends Date {
      getTime(): number {
        throw new Error('SHOULD-NOT-BE-CALLED');
      }

      toISOString(): string {
        throw new Error('SHOULD-NOT-BE-CALLED');
      }
    }

    const body = toBotApplicationOutcomeResponse(
      ack({ ackReceivedAt: new SneakyDate(ACK_AT_ISO) }),
    );

    expect(body.ackReceivedAt).toBe(ACK_AT_ISO);
  });

  it('fails closed on a Proxy-wrapped Date', () => {
    const dateProxy = new Proxy(new Date(ACK_AT_ISO), {});

    expectConstantError(() =>
      toBotApplicationOutcomeResponse(ack({ ackReceivedAt: dateProxy })),
    );
  });
});

describe('toBotApplicationOutcomeResponse — no input mutation', () => {
  it('does not mutate the Date, the scalar fields or the input object', () => {
    const ackReceivedAt = new Date(ACK_AT_ISO);
    const acknowledgment = ack({ ackReceivedAt });
    const time = ackReceivedAt.getTime();

    toBotApplicationOutcomeResponse(acknowledgment);

    expect(acknowledgment.ackReceivedAt).toBe(ackReceivedAt);
    expect(ackReceivedAt.getTime()).toBe(time);
    expect(acknowledgment.id).toBe(DECISION_ID);
    expect(acknowledgment.version).toBe(2);
    expect(acknowledgment.attemptId).toBe(ATTEMPT_ID);
    expect(acknowledgment.outcome).toBe(PROVIDER_ACCEPTED);
    expect(Object.keys(acknowledgment).sort()).toEqual(
      [...EXPECTED_TOP_LEVEL_KEYS].sort(),
    );
  });

  it('returns a fresh object that is not the input reference', () => {
    const acknowledgment = ack();
    const body = toBotApplicationOutcomeResponse(acknowledgment);

    expect(body).not.toBe(acknowledgment);
    expect(body.ackReceivedAt).not.toBe(acknowledgment.ackReceivedAt);
  });
});
