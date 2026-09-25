/**
 * HD-05b1 — `parseBotApplicationOutcomeRequest` and
 * `hashBotApplicationOutcomeEvidence` spec.
 *
 * Proves the terminal ACK body is parsed as an EXACT four-variant union: only
 * the variant's keys survive, authority/unknown keys and `evidenceCode` are
 * rejected rather than stripped, optional evidence is omitted (never `null`),
 * forbidden evidence is rejected even as `null`, the version is never
 * hard-coded so a stale value reaches CAS, timestamps are canonical UTC with a
 * real calendar instant and `providerAcceptedObservedAt >= attemptedAt`, and
 * the provider message ID stays byte-exact under a 512 UTF-16-unit cap.
 *
 * Own-key integrity additionally rejects non-enumerable and symbol extras,
 * rejects accessor keys without invoking their getters, and converts throwing
 * Proxy traps to the fixed value-free error. The evidence hash is pinned by
 * golden fixtures (canonical JSON + SHA-256) for four outcomes and proved
 * order-independent, replay-stable and payload-sensitive.
 *
 * `canonicalizeBotApplicationOutcomeEvidence` and
 * `hashBotApplicationOutcomeEvidence` accept `unknown` and re-validate through
 * the parser, because a static type is not a runtime guarantee. The spec feeds
 * BOTH helpers raw, never-parsed JS (forbidden `evidenceCode`, extra
 * `actor`/`source`, STALE `attemptedAt:null`, UNKNOWN
 * `providerAcceptedObservedAt:null`), and proves accessor/Proxy traps fail
 * closed value-free, well-formed raw input projects and hashes exactly like its
 * parsed form, and raw input is never mutated.
 *
 * Approved design (read-only):
 * `houndfe-chatbot-human-decisions/docs/human-decisions-contract-v1.md`.
 */
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import {
  canonicalizeBotApplicationOutcomeEvidence,
  DELIVERY_UNKNOWN,
  hashBotApplicationOutcomeEvidence,
  INVALID_OUTCOME_REQUEST_CODE,
  PROVIDER_ACCEPTED,
  PROVIDER_ACCEPTED_LATE,
  PROVIDER_MESSAGE_ID_MAX_LENGTH,
  parseBotApplicationOutcomeRequest,
  STALE,
  type DeliveryUnknownRequest,
  type ProviderAcceptedLateRequest,
  type ProviderAcceptedRequest,
  type StaleRequest,
} from './bot-application-outcome.request';

const ATTEMPT_ID = '3f1c1b7a-9c2e-4d5f-8a6b-1c2d3e4f5a6b';
const UUID_V1 = 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6';
const UUID_V7 = '0192a1b2-c3d4-7e5f-8a6b-1c2d3e4f5a6b';
const UUID_V8 = '3f1c1b7a-9c2e-8d5f-8a6b-1c2d3e4f5a6b';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const VERSION_0_UUID = '3f1c1b7a-9c2e-0d5f-8a6b-1c2d3e4f5a6b';
const VERSION_9_UUID = '3f1c1b7a-9c2e-9d5f-8a6b-1c2d3e4f5a6b';
const INVALID_VARIANT_UUID = '3f1c1b7a-9c2e-4d5f-0a6b-1c2d3e4f5a6b';

const PROVIDER_MESSAGE_ID = 'wamid.HBgLMTIzNDU2Nzg5MA==';
const ATTEMPTED_AT = '2026-06-15T12:00:00.000Z';
const ACCEPTED_OBSERVED_AT = '2026-06-15T12:00:04.500Z';
const LATE_ATTEMPTED_AT = '2026-06-15T12:59:59.000Z';
const LATE_ACCEPTED_OBSERVED_AT = '2026-06-15T13:05:00.000Z';

/** Keys an untrusted ACK body might try to smuggle in; ALL must be rejected. */
const AUTHORITY_KEYS = [
  'decisionId',
  'tenantId',
  'source',
  'credentialId',
  'submittedCredentialId',
  'actor',
  'reviewerId',
  'branchId',
  'resolvedAt',
  'applyBefore',
  'ackReceivedAt',
  'evidenceCode',
  'resolution',
  'idempotencyKey',
  'requestHash',
  'note',
  'reason',
  'message',
  'freeText',
] as const;

const ACCEPTED_KEY_ORDER = [
  'attemptId',
  'attemptedAt',
  'expectedResolutionVersion',
  'outcome',
  'providerAcceptedObservedAt',
  'providerMessageId',
] as const;

function acceptedBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    attemptId: ATTEMPT_ID,
    attemptedAt: ATTEMPTED_AT,
    expectedResolutionVersion: 2,
    outcome: PROVIDER_ACCEPTED,
    providerAcceptedObservedAt: ACCEPTED_OBSERVED_AT,
    providerMessageId: PROVIDER_MESSAGE_ID,
    ...overrides,
  };
}

function lateBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    attemptId: ATTEMPT_ID,
    attemptedAt: LATE_ATTEMPTED_AT,
    expectedResolutionVersion: 2,
    outcome: PROVIDER_ACCEPTED_LATE,
    providerAcceptedObservedAt: LATE_ACCEPTED_OBSERVED_AT,
    providerMessageId: PROVIDER_MESSAGE_ID,
    ...overrides,
  };
}

/** `DELIVERY_UNKNOWN` with the audit-only ID OMITTED (not `null`). */
function unknownBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    attemptId: ATTEMPT_ID,
    attemptedAt: ATTEMPTED_AT,
    expectedResolutionVersion: 7,
    outcome: DELIVERY_UNKNOWN,
    ...overrides,
  };
}

/** `DELIVERY_UNKNOWN` carrying the audit-only provider message ID. */
function unknownWithIdBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...unknownBody(),
    providerMessageId: PROVIDER_MESSAGE_ID,
    ...overrides,
  };
}

function staleBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    attemptId: ATTEMPT_ID,
    expectedResolutionVersion: 2,
    outcome: STALE,
    ...overrides,
  };
}

function omit(
  body: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  const clone = { ...body };
  for (const key of keys) {
    delete clone[key];
  }
  return clone;
}

function reverseKeys(body: Record<string, unknown>): Record<string, unknown> {
  const reversed: Record<string, unknown> = {};
  for (const key of Object.keys(body).reverse()) {
    reversed[key] = body[key];
  }
  return reversed;
}

/**
 * Inject an extra own key at runtime. This models a future adapter handing raw
 * JS to a helper that previously trusted its static parameter type.
 */
function withOwnKey<T extends object>(
  target: T,
  key: string,
  value: unknown,
): T {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return target;
}

function expectInvalid(value: unknown): void {
  expect(() => parseBotApplicationOutcomeRequest(value)).toThrow(
    InvalidArgumentError,
  );
}

/** Narrow without a type assertion so no cast can mask a wrong error class. */
function captureInvalidArgumentError(run: () => unknown): InvalidArgumentError {
  try {
    run();
  } catch (error) {
    if (error instanceof InvalidArgumentError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the parser to reject the value');
}

const INVALID_VERSIONS: readonly unknown[] = [
  0,
  -1,
  1.5,
  Number.MAX_SAFE_INTEGER + 1,
  NaN,
  Infinity,
  '2',
  null,
  true,
  [],
  {},
];

const INVALID_ATTEMPT_IDS: readonly unknown[] = [
  NIL_UUID,
  VERSION_0_UUID,
  VERSION_9_UUID,
  INVALID_VARIANT_UUID,
  'not-a-uuid',
  '',
  '   ',
  '3f1c1b7a-9c2e-4d5f-8a6b-1c2d3e4f5a6',
  null,
  42,
  true,
  {},
  [],
];

const INVALID_TIMESTAMPS: readonly unknown[] = [
  '2026-06-15T12:00:00Z',
  '2026-06-15T12:00:00.00Z',
  '2026-06-15T12:00:00.0000Z',
  '2026-06-15T12:00:00.000+00:00',
  '2026-06-15T12:00:00.000+02:00',
  '2026-06-15T12:00:00.000-05:00',
  '2026-06-15T12:00:00.000z',
  '2026-06-15 12:00:00.000Z',
  '2026-06-15T12:00:00.000Z ',
  ' 2026-06-15T12:00:00.000Z',
  '2026-6-15T12:00:00.000Z',
  '20260615T120000.000Z',
  '2026-13-01T00:00:00.000Z',
  '2026-00-10T00:00:00.000Z',
  '2026-06-00T00:00:00.000Z',
  '2026-06-31T12:00:00.000Z',
  '2026-02-30T12:00:00.000Z',
  '2023-02-29T12:00:00.000Z',
  '2026-06-15T24:00:00.000Z',
  '2026-06-15T12:60:00.000Z',
  '2026-06-15T12:00:60.000Z',
  '-0001-01-01T00:00:00.000Z',
  '+2026-06-15T12:00:00.000Z',
  '',
  '   ',
  'null',
  null,
  42,
  true,
  {},
  [],
  new Date('2026-06-15T12:00:00.000Z'),
];

const VALID_TIMESTAMPS: readonly string[] = [
  '2026-06-15T12:00:00.000Z',
  '2024-02-29T00:00:00.000Z',
  '2026-12-31T23:59:59.999Z',
  '2026-01-01T00:00:00.000Z',
];

const INVALID_PROVIDER_MESSAGE_IDS: readonly unknown[] = [
  '',
  '   ',
  ' leading',
  'trailing ',
  'in\u0000ter',
  'in\u001fter',
  'in\u007fter',
  'in\u0085ter',
  'in\u009fter',
  'line\nbreak',
  'e\u0301',
  null,
  42,
  true,
  {},
  [],
  'x'.repeat(PROVIDER_MESSAGE_ID_MAX_LENGTH + 1),
];

describe('parseBotApplicationOutcomeRequest', () => {
  it('parses PROVIDER_ACCEPTED with exactly its six keys', () => {
    const parsed = parseBotApplicationOutcomeRequest(acceptedBody());

    expect(parsed).toEqual({
      attemptId: ATTEMPT_ID,
      expectedResolutionVersion: 2,
      outcome: PROVIDER_ACCEPTED,
      attemptedAt: ATTEMPTED_AT,
      providerMessageId: PROVIDER_MESSAGE_ID,
      providerAcceptedObservedAt: ACCEPTED_OBSERVED_AT,
    });
    expect(Object.keys(parsed).sort()).toEqual([...ACCEPTED_KEY_ORDER]);
  });

  it('parses PROVIDER_ACCEPTED_LATE with exactly its six keys', () => {
    const parsed = parseBotApplicationOutcomeRequest(lateBody());

    expect(parsed).toEqual({
      attemptId: ATTEMPT_ID,
      expectedResolutionVersion: 2,
      outcome: PROVIDER_ACCEPTED_LATE,
      attemptedAt: LATE_ATTEMPTED_AT,
      providerMessageId: PROVIDER_MESSAGE_ID,
      providerAcceptedObservedAt: LATE_ACCEPTED_OBSERVED_AT,
    });
    expect(Object.keys(parsed).sort()).toEqual([...ACCEPTED_KEY_ORDER]);
  });

  it('parses DELIVERY_UNKNOWN without providerMessageId (key OMITTED, never null)', () => {
    const parsed = parseBotApplicationOutcomeRequest(unknownBody());

    expect(parsed).toEqual({
      attemptId: ATTEMPT_ID,
      expectedResolutionVersion: 7,
      outcome: DELIVERY_UNKNOWN,
      attemptedAt: ATTEMPTED_AT,
    });
    expect(Object.keys(parsed).sort()).toEqual([
      'attemptId',
      'attemptedAt',
      'expectedResolutionVersion',
      'outcome',
    ]);
    expect(
      Object.prototype.hasOwnProperty.call(parsed, 'providerMessageId'),
    ).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(
        parsed,
        'providerAcceptedObservedAt',
      ),
    ).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain('null');
  });

  it('parses DELIVERY_UNKNOWN with the audit-only providerMessageId', () => {
    const parsed = parseBotApplicationOutcomeRequest(unknownWithIdBody());

    expect(parsed).toEqual({
      attemptId: ATTEMPT_ID,
      expectedResolutionVersion: 7,
      outcome: DELIVERY_UNKNOWN,
      attemptedAt: ATTEMPTED_AT,
      providerMessageId: PROVIDER_MESSAGE_ID,
    });
    expect(Object.keys(parsed).sort()).toEqual([
      'attemptId',
      'attemptedAt',
      'expectedResolutionVersion',
      'outcome',
      'providerMessageId',
    ]);
  });

  it('parses STALE with exactly its three keys and no null on the wire', () => {
    const parsed = parseBotApplicationOutcomeRequest(staleBody());

    expect(parsed).toEqual({
      attemptId: ATTEMPT_ID,
      expectedResolutionVersion: 2,
      outcome: STALE,
    });
    expect(Object.keys(parsed).sort()).toEqual([
      'attemptId',
      'expectedResolutionVersion',
      'outcome',
    ]);
    expect(JSON.stringify(parsed)).not.toContain('null');
  });

  it.each([
    ['PROVIDER_ACCEPTED', acceptedBody()],
    ['PROVIDER_ACCEPTED_LATE', lateBody()],
    ['DELIVERY_UNKNOWN', unknownBody()],
    ['STALE', staleBody()],
  ])('accepts the %s variant with a positive version 1', (_name, body) => {
    const parsed = parseBotApplicationOutcomeRequest({
      ...body,
      expectedResolutionVersion: 1,
    });

    expect(parsed.expectedResolutionVersion).toBe(1);
  });

  it.each([1, 3, 7, 123_456])(
    'accepts a positive expectedResolutionVersion %i (never hardcoded to 2; stale reaches CAS)',
    (version) => {
      expect(
        parseBotApplicationOutcomeRequest(
          unknownBody({ expectedResolutionVersion: version }),
        ).expectedResolutionVersion,
      ).toBe(version);
    },
  );

  it.each(INVALID_VERSIONS)(
    'rejects invalid expectedResolutionVersion %p',
    (version) => {
      expectInvalid(unknownBody({ expectedResolutionVersion: version }));
    },
  );

  it.each([UUID_V1, ATTEMPT_ID, UUID_V7, UUID_V8])(
    'accepts canonical RFC 4122 v1-v8 attemptId %s',
    (uuid) => {
      expect(
        parseBotApplicationOutcomeRequest(staleBody({ attemptId: uuid }))
          .attemptId,
      ).toBe(uuid);
    },
  );

  it.each(INVALID_ATTEMPT_IDS)('rejects nil/invalid attemptId %p', (uuid) => {
    expectInvalid(staleBody({ attemptId: uuid }));
  });

  it('trims and lowercases attemptId like HD-02a', () => {
    const raw = `  ${ATTEMPT_ID.toUpperCase()}  `;

    expect(
      parseBotApplicationOutcomeRequest(staleBody({ attemptId: raw }))
        .attemptId,
    ).toBe(ATTEMPT_ID);
  });

  it.each([
    'PROVIDER_ACCEPTED',
    'provider_accepted',
    'ACCEPTED',
    'UNKNOWN',
    'STALED',
    '',
    null,
    1,
    true,
    {},
    [],
  ])('rejects an invalid outcome %p on the base shape', (outcome) => {
    expectInvalid({
      attemptId: ATTEMPT_ID,
      expectedResolutionVersion: 2,
      outcome,
    });
  });

  it('rejects an undefined outcome', () => {
    expectInvalid({
      attemptId: ATTEMPT_ID,
      expectedResolutionVersion: 2,
      outcome: undefined,
    });
  });

  it.each(VALID_TIMESTAMPS)('accepts the canonical UTC timestamp %s', (ts) => {
    const parsed = parseBotApplicationOutcomeRequest(
      acceptedBody({
        attemptedAt: ts,
        providerAcceptedObservedAt: ts,
      }),
    );

    expect(parsed).toEqual(
      expect.objectContaining({
        attemptedAt: ts,
        providerAcceptedObservedAt: ts,
      }),
    );
  });

  it.each(INVALID_TIMESTAMPS)(
    'rejects the malformed timestamp %p on attemptedAt and providerAcceptedObservedAt',
    (ts) => {
      expectInvalid(acceptedBody({ attemptedAt: ts }));
      expectInvalid(acceptedBody({ providerAcceptedObservedAt: ts }));
    },
  );

  it('accepts providerAcceptedObservedAt exactly equal to attemptedAt', () => {
    const parsed = parseBotApplicationOutcomeRequest(
      acceptedBody({ providerAcceptedObservedAt: ATTEMPTED_AT }),
    );

    expect(parsed).toEqual(
      expect.objectContaining({ providerAcceptedObservedAt: ATTEMPTED_AT }),
    );
  });

  it('rejects providerAcceptedObservedAt strictly BEFORE attemptedAt', () => {
    expectInvalid(
      acceptedBody({ providerAcceptedObservedAt: '2026-06-15T11:59:59.999Z' }),
    );
    expectInvalid(
      lateBody({
        providerAcceptedObservedAt: LATE_ATTEMPTED_AT.slice(0, -5) + '08.000Z',
      }),
    );
  });

  it('accepts a millisecond-after attempt timestamp', () => {
    const parsed = parseBotApplicationOutcomeRequest(
      acceptedBody({ providerAcceptedObservedAt: '2026-06-15T12:00:00.001Z' }),
    );

    expect(parsed).toEqual(
      expect.objectContaining({
        providerAcceptedObservedAt: '2026-06-15T12:00:00.001Z',
      }),
    );
  });

  it('rejects null for a present attemptedAt', () => {
    expectInvalid(acceptedBody({ attemptedAt: null }));
    expectInvalid(unknownBody({ attemptedAt: null }));
  });

  it.each([
    PROVIDER_MESSAGE_ID,
    'a',
    'x'.repeat(PROVIDER_MESSAGE_ID_MAX_LENGTH),
  ])('accepts the providerMessageId %p', (id) => {
    expect(
      parseBotApplicationOutcomeRequest(
        acceptedBody({ providerMessageId: id }),
      ),
    ).toEqual(expect.objectContaining({ providerMessageId: id }));
  });

  it.each(INVALID_PROVIDER_MESSAGE_IDS)(
    'rejects the invalid providerMessageId %p (never truncated or normalized)',
    (id) => {
      expectInvalid(acceptedBody({ providerMessageId: id }));
      expectInvalid(unknownWithIdBody({ providerMessageId: id }));
    },
  );

  it('rejects providerMessageId over the UTF-16 cap by exactly one unit', () => {
    const tooLong = 'x'.repeat(PROVIDER_MESSAGE_ID_MAX_LENGTH + 1);

    expect(tooLong.length).toBe(PROVIDER_MESSAGE_ID_MAX_LENGTH + 1);
    expectInvalid(acceptedBody({ providerMessageId: tooLong }));
  });

  it('rejects null for a present providerMessageId', () => {
    expectInvalid(acceptedBody({ providerMessageId: null }));
    expectInvalid(unknownWithIdBody({ providerMessageId: null }));
  });

  it.each(AUTHORITY_KEYS)(
    'rejects the authority/unknown key %s on every variant',
    (key) => {
      expectInvalid(acceptedBody({ [key]: 'smuggled' }));
      expectInvalid(lateBody({ [key]: 'smuggled' }));
      expectInvalid(unknownBody({ [key]: 'smuggled' }));
      expectInvalid(staleBody({ [key]: 'smuggled' }));
    },
  );

  it('rejects evidenceCode even as null on every variant', () => {
    expectInvalid(acceptedBody({ evidenceCode: null }));
    expectInvalid(lateBody({ evidenceCode: null }));
    expectInvalid(unknownBody({ evidenceCode: null }));
    expectInvalid(staleBody({ evidenceCode: null }));
  });

  it.each([
    'attemptId',
    'attemptedAt',
    'expectedResolutionVersion',
    'outcome',
    'providerAcceptedObservedAt',
    'providerMessageId',
  ])('rejects a PROVIDER_ACCEPTED body missing %s', (key) => {
    expectInvalid(omit(acceptedBody(), [key]));
    expectInvalid(omit(lateBody(), [key]));
  });

  it.each(['attemptId', 'attemptedAt', 'expectedResolutionVersion', 'outcome'])(
    'rejects a DELIVERY_UNKNOWN body missing %s',
    (key) => {
      expectInvalid(omit(unknownBody(), [key]));
      expectInvalid(omit(unknownWithIdBody(), [key]));
    },
  );

  it.each(['attemptId', 'expectedResolutionVersion', 'outcome'])(
    'rejects a STALE body missing %s',
    (key) => {
      expectInvalid(omit(staleBody(), [key]));
    },
  );

  it.each([null, undefined, '2026-06-15T12:00:04.500Z'])(
    'rejects providerAcceptedObservedAt %p on DELIVERY_UNKNOWN (forbidden even as null)',
    (value) => {
      expectInvalid({ ...unknownBody(), providerAcceptedObservedAt: value });
      expectInvalid({
        ...unknownWithIdBody(),
        providerAcceptedObservedAt: value,
      });
    },
  );

  it.each([null, undefined, ATTEMPTED_AT])(
    'rejects attemptedAt %p on STALE (forbidden even as null)',
    (value) => {
      expectInvalid({ ...staleBody(), attemptedAt: value });
    },
  );

  it.each([null, undefined, PROVIDER_MESSAGE_ID])(
    'rejects providerMessageId %p on STALE (forbidden even as null)',
    (value) => {
      expectInvalid({ ...staleBody(), providerMessageId: value });
    },
  );

  it.each([null, undefined, ACCEPTED_OBSERVED_AT])(
    'rejects providerAcceptedObservedAt %p on STALE (forbidden even as null)',
    (value) => {
      expectInvalid({ ...staleBody(), providerAcceptedObservedAt: value });
    },
  );

  it.each([
    null,
    'PROVIDER_ACCEPTED',
    42,
    true,
    [],
    [{ outcome: PROVIDER_ACCEPTED }],
  ])('rejects a non-record body %p', (value) => {
    expect(() => parseBotApplicationOutcomeRequest(value)).toThrow(
      InvalidArgumentError,
    );
  });

  it('rejects an undefined body', () => {
    expectInvalid(undefined);
  });

  it('fails value-free with one fixed message and code', () => {
    const secret = 'PII-secret-42';
    const first = captureInvalidArgumentError(() =>
      parseBotApplicationOutcomeRequest(
        acceptedBody({ providerMessageId: secret, attemptedAt: secret }),
      ),
    );
    const second = captureInvalidArgumentError(() =>
      parseBotApplicationOutcomeRequest({
        ...staleBody(),
        note: secret,
      }),
    );

    expect(first.message).toBe(second.message);
    expect(first.code).toBe(INVALID_OUTCOME_REQUEST_CODE);
    expect(second.code).toBe(INVALID_OUTCOME_REQUEST_CODE);
    expect(first.message).not.toContain(secret);
    expect(second.message).not.toContain(secret);
    expect(
      JSON.stringify(second, Object.getOwnPropertyNames(second)),
    ).not.toContain(secret);
    expect((first as { value?: unknown }).value).toBeUndefined();
  });

  it('does not mutate or alias the input body', () => {
    const body = acceptedBody();
    const snapshot: Record<string, unknown> = { ...body };
    Object.freeze(body);

    const parsed = parseBotApplicationOutcomeRequest(body);

    expect(body).toEqual(snapshot);
    expect(parsed).not.toBe(body);
    expect(parsed).toEqual(snapshot);
  });
});

describe('parseBotApplicationOutcomeRequest own-key integrity', () => {
  it('rejects an extra non-enumerable own key that Object.keys would hide', () => {
    const body = unknownBody();
    Object.defineProperty(body, 'smuggled', {
      value: 'x',
      enumerable: false,
      writable: true,
      configurable: true,
    });

    expectInvalid(body);
  });

  it('rejects an extra symbol own key', () => {
    const body = staleBody();
    Reflect.set(body, Symbol('smuggled'), 'x');

    expectInvalid(body);
  });

  it('rejects an accessor outcome key without invoking its getter', () => {
    let getterInvoked = false;
    const body = unknownBody();
    Object.defineProperty(body, 'outcome', {
      get() {
        getterInvoked = true;
        throw new Error('accessor-secret');
      },
      enumerable: true,
      configurable: true,
    });

    expectInvalid(body);
    expect(getterInvoked).toBe(false);
  });

  it('rejects an accessor evidence key without invoking its getter', () => {
    let getterInvoked = false;
    const body = acceptedBody();
    Object.defineProperty(body, 'providerMessageId', {
      get() {
        getterInvoked = true;
        throw new Error('accessor-secret');
      },
      enumerable: true,
      configurable: true,
    });

    expectInvalid(body);
    expect(getterInvoked).toBe(false);
  });

  it('rejects a required key that is own but non-enumerable', () => {
    const body = staleBody();
    Object.defineProperty(body, 'outcome', {
      value: STALE,
      enumerable: false,
      writable: true,
      configurable: true,
    });

    expectInvalid(body);
  });

  it('accepts an exact null-prototype body', () => {
    const body = Object.create(null) as Record<string, unknown>;
    body.attemptId = ATTEMPT_ID;
    body.expectedResolutionVersion = 2;
    body.outcome = STALE;

    expect(parseBotApplicationOutcomeRequest(body)).toEqual({
      attemptId: ATTEMPT_ID,
      expectedResolutionVersion: 2,
      outcome: STALE,
    });
  });

  it('ignores inherited properties and rejects inherited-only required keys', () => {
    const inherited = Object.create({
      attemptId: ATTEMPT_ID,
      expectedResolutionVersion: 2,
    }) as Record<string, unknown>;
    inherited.outcome = STALE;

    expectInvalid(inherited);
  });

  it('converts a throwing Proxy ownKeys trap to the fixed value-free error', () => {
    const secret = 'ownKeys-trap-secret';
    const proxy = new Proxy(unknownBody(), {
      ownKeys() {
        throw new Error(secret);
      },
    });

    const error = captureInvalidArgumentError(() =>
      parseBotApplicationOutcomeRequest(proxy),
    );

    expect(error.code).toBe(INVALID_OUTCOME_REQUEST_CODE);
    expect(error.message).not.toContain(secret);
  });

  it('converts a throwing Proxy getOwnPropertyDescriptor trap to the fixed error', () => {
    const secret = 'descriptor-trap-secret';
    const proxy = new Proxy(unknownBody(), {
      getOwnPropertyDescriptor() {
        throw new Error(secret);
      },
    });

    const error = captureInvalidArgumentError(() =>
      parseBotApplicationOutcomeRequest(proxy),
    );

    expect(error.code).toBe(INVALID_OUTCOME_REQUEST_CODE);
    expect(error.message).not.toContain(secret);
  });

  it('replaces a Proxy trap throwing InvalidArgumentError with the fixed error', () => {
    const sentinel = 'secret-sentinel';
    const proxy = new Proxy(unknownBody(), {
      ownKeys() {
        throw new InvalidArgumentError(sentinel, 'EVIL_CODE');
      },
    });

    const fixed = captureInvalidArgumentError(() =>
      parseBotApplicationOutcomeRequest(null),
    );
    const error = captureInvalidArgumentError(() =>
      parseBotApplicationOutcomeRequest(proxy),
    );

    expect(error.message).toBe(fixed.message);
    expect(error.code).toBe(INVALID_OUTCOME_REQUEST_CODE);
    expect(error.message).not.toContain(sentinel);
    expect(
      JSON.stringify(error, Object.getOwnPropertyNames(error)),
    ).not.toContain(sentinel);
  });

  it('replaces a Proxy getOwnPropertyDescriptor trap throwing InvalidArgumentError with the fixed error', () => {
    const sentinel = 'secret-sentinel';
    const proxy = new Proxy(staleBody(), {
      getOwnPropertyDescriptor() {
        throw new InvalidArgumentError(sentinel, 'EVIL_CODE');
      },
    });

    const fixed = captureInvalidArgumentError(() =>
      parseBotApplicationOutcomeRequest(null),
    );
    const error = captureInvalidArgumentError(() =>
      parseBotApplicationOutcomeRequest(proxy),
    );

    expect(error.message).toBe(fixed.message);
    expect(error.code).toBe(INVALID_OUTCOME_REQUEST_CODE);
    expect(
      JSON.stringify(error, Object.getOwnPropertyNames(error)),
    ).not.toContain(sentinel);
  });

  it('never invokes a Proxy get trap for any value', () => {
    let getInvoked = false;
    const proxy = new Proxy(acceptedBody(), {
      get(target, property) {
        getInvoked = true;
        return Reflect.get(target, property) as unknown;
      },
    });

    expect(parseBotApplicationOutcomeRequest(proxy)).toEqual({
      attemptId: ATTEMPT_ID,
      expectedResolutionVersion: 2,
      outcome: PROVIDER_ACCEPTED,
      attemptedAt: ATTEMPTED_AT,
      providerMessageId: PROVIDER_MESSAGE_ID,
      providerAcceptedObservedAt: ACCEPTED_OBSERVED_AT,
    });
    expect(getInvoked).toBe(false);
  });
});

describe('hashBotApplicationOutcomeEvidence', () => {
  const GOLDEN = [
    {
      name: 'PROVIDER_ACCEPTED',
      body: acceptedBody(),
      canonical:
        '{"attemptId":"3f1c1b7a-9c2e-4d5f-8a6b-1c2d3e4f5a6b","attemptedAt":"2026-06-15T12:00:00.000Z","expectedResolutionVersion":2,"outcome":"PROVIDER_ACCEPTED","providerAcceptedObservedAt":"2026-06-15T12:00:04.500Z","providerMessageId":"wamid.HBgLMTIzNDU2Nzg5MA=="}',
      hash: 'cc7534e067b71d1fc099250b65cab69dd714f1ec7b8c389d8ab8974c7e836831',
    },
    {
      name: 'PROVIDER_ACCEPTED_LATE',
      body: lateBody(),
      canonical:
        '{"attemptId":"3f1c1b7a-9c2e-4d5f-8a6b-1c2d3e4f5a6b","attemptedAt":"2026-06-15T12:59:59.000Z","expectedResolutionVersion":2,"outcome":"PROVIDER_ACCEPTED_LATE","providerAcceptedObservedAt":"2026-06-15T13:05:00.000Z","providerMessageId":"wamid.HBgLMTIzNDU2Nzg5MA=="}',
      hash: 'd990c98975690967f6b7e179ddd88c0be6d7549ac4286334985395dbd76d0a7a',
    },
    {
      name: 'DELIVERY_UNKNOWN with audit-only ID',
      body: unknownWithIdBody(),
      canonical:
        '{"attemptId":"3f1c1b7a-9c2e-4d5f-8a6b-1c2d3e4f5a6b","attemptedAt":"2026-06-15T12:00:00.000Z","expectedResolutionVersion":7,"outcome":"DELIVERY_UNKNOWN","providerAcceptedObservedAt":null,"providerMessageId":"wamid.HBgLMTIzNDU2Nzg5MA=="}',
      hash: 'a009778c8f9632b94375119ce9b911019e5bf6e4437a5b7bba79eac2f6d7c424',
    },
    {
      name: 'DELIVERY_UNKNOWN without ID',
      body: unknownBody(),
      canonical:
        '{"attemptId":"3f1c1b7a-9c2e-4d5f-8a6b-1c2d3e4f5a6b","attemptedAt":"2026-06-15T12:00:00.000Z","expectedResolutionVersion":7,"outcome":"DELIVERY_UNKNOWN","providerAcceptedObservedAt":null,"providerMessageId":null}',
      hash: '184f50938342cad54adbabf50f8ebb684135f3fb080ff2f356632d64b229d750',
    },
    {
      name: 'STALE',
      body: staleBody(),
      canonical:
        '{"attemptId":"3f1c1b7a-9c2e-4d5f-8a6b-1c2d3e4f5a6b","attemptedAt":null,"expectedResolutionVersion":2,"outcome":"STALE","providerAcceptedObservedAt":null,"providerMessageId":null}',
      hash: 'b623f85e54953edac8a33a25f84c8fdbe9c7baae60bdb4fe3d05d550c99ed9f0',
    },
  ] as const;

  it.each(GOLDEN)(
    'matches the pinned golden canonical JSON and SHA-256 for $name',
    ({ body, canonical, hash }) => {
      const parsed = parseBotApplicationOutcomeRequest(body);
      const projected = canonicalizeBotApplicationOutcomeEvidence(parsed);

      expect(Object.keys(projected)).toEqual([...ACCEPTED_KEY_ORDER]);
      expect(JSON.stringify(projected)).toBe(canonical);
      expect(hashBotApplicationOutcomeEvidence(parsed)).toBe(hash);
    },
  );

  it.each(GOLDEN)('returns a lowercase 64-hex digest for $name', ({ body }) => {
    const hash = hashBotApplicationOutcomeEvidence(
      parseBotApplicationOutcomeRequest(body),
    );

    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('omitted optionals become null ONLY inside the hash object, never on the wire', () => {
    const parsed = parseBotApplicationOutcomeRequest(unknownBody());
    const projected = canonicalizeBotApplicationOutcomeEvidence(parsed);

    expect(projected.providerMessageId).toBeNull();
    expect(projected.providerAcceptedObservedAt).toBeNull();
    expect(
      Object.prototype.hasOwnProperty.call(parsed, 'providerMessageId'),
    ).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain('null');
  });

  it('is replay-stable for the exact same body', () => {
    const first = hashBotApplicationOutcomeEvidence(
      parseBotApplicationOutcomeRequest(acceptedBody()),
    );
    const second = hashBotApplicationOutcomeEvidence(
      parseBotApplicationOutcomeRequest(acceptedBody()),
    );

    expect(second).toBe(first);
  });

  it('is independent of the input object key order', () => {
    const forward = hashBotApplicationOutcomeEvidence(
      parseBotApplicationOutcomeRequest(acceptedBody()),
    );
    const reversed = hashBotApplicationOutcomeEvidence(
      parseBotApplicationOutcomeRequest(reverseKeys(acceptedBody())),
    );

    expect(Object.keys(acceptedBody())).not.toEqual(
      Object.keys(reverseKeys(acceptedBody())),
    );
    expect(reversed).toBe(forward);
  });

  it.each([
    ['attemptId', { attemptId: UUID_V7 }],
    ['expectedResolutionVersion', { expectedResolutionVersion: 3 }],
    ['attemptedAt', { attemptedAt: '2026-06-15T12:00:01.000Z' }],
    [
      'providerAcceptedObservedAt',
      { providerAcceptedObservedAt: ATTEMPTED_AT },
    ],
    ['providerMessageId', { providerMessageId: 'wamid.DIFFERENT' }],
  ])('changes the hash when %s changes', (_field, override) => {
    const baseline = hashBotApplicationOutcomeEvidence(
      parseBotApplicationOutcomeRequest(
        acceptedBody({ providerAcceptedObservedAt: ACCEPTED_OBSERVED_AT }),
      ),
    );
    const changed = hashBotApplicationOutcomeEvidence(
      parseBotApplicationOutcomeRequest(acceptedBody(override)),
    );

    expect(changed).not.toBe(baseline);
  });

  it('changes the hash when the outcome changes', () => {
    const accepted = hashBotApplicationOutcomeEvidence(
      parseBotApplicationOutcomeRequest(acceptedBody()),
    );
    const late = hashBotApplicationOutcomeEvidence(
      parseBotApplicationOutcomeRequest(lateBody()),
    );

    expect(late).not.toBe(accepted);
  });

  it('excludes decisionId, tenant/source, credential, evidenceCode, audit timestamps and bot text', () => {
    const projected = canonicalizeBotApplicationOutcomeEvidence(
      parseBotApplicationOutcomeRequest(acceptedBody()),
    );
    const keys = Object.keys(projected);

    expect(keys).toEqual([
      'attemptId',
      'attemptedAt',
      'expectedResolutionVersion',
      'outcome',
      'providerAcceptedObservedAt',
      'providerMessageId',
    ]);
    for (const forbidden of [
      'decisionId',
      'tenantId',
      'source',
      'credentialId',
      'evidenceCode',
      'ackReceivedAt',
      'attemptedAtUtc',
      'note',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('is pure and does not mutate the parsed command', () => {
    const parsed = parseBotApplicationOutcomeRequest(acceptedBody());
    const snapshot = { ...parsed };

    const hash = hashBotApplicationOutcomeEvidence(parsed);

    expect(parsed).toEqual(snapshot);
    expect(hashBotApplicationOutcomeEvidence(parsed)).toBe(hash);
  });

  it('separates the STALE and no-ID UNKNOWN hashes (distinct field sets)', () => {
    const stale = hashBotApplicationOutcomeEvidence(
      parseBotApplicationOutcomeRequest(
        staleBody({ expectedResolutionVersion: 7 }),
      ),
    );
    const unknown = hashBotApplicationOutcomeEvidence(
      parseBotApplicationOutcomeRequest(unknownBody()),
    );

    expect(stale).not.toBe(unknown);
  });
});

describe('evidence helpers fail closed on untrusted runtime input', () => {
  const HOSTILE = [
    {
      name: 'evidenceCode:null on PROVIDER_ACCEPTED',
      build: () =>
        withOwnKey(
          parseBotApplicationOutcomeRequest(acceptedBody()),
          'evidenceCode',
          null,
        ),
    },
    {
      name: 'extra actor/source keys on DELIVERY_UNKNOWN',
      build: () =>
        withOwnKey(
          withOwnKey(
            parseBotApplicationOutcomeRequest(unknownBody()),
            'actor',
            'smuggled-actor',
          ),
          'source',
          'smuggled-source',
        ),
    },
    {
      name: 'STALE carrying attemptedAt:null',
      build: () =>
        withOwnKey(
          parseBotApplicationOutcomeRequest(staleBody()),
          'attemptedAt',
          null,
        ),
    },
    {
      name: 'DELIVERY_UNKNOWN carrying providerAcceptedObservedAt:null',
      build: () =>
        withOwnKey(
          parseBotApplicationOutcomeRequest(unknownBody()),
          'providerAcceptedObservedAt',
          null,
        ),
    },
  ];

  it.each(HOSTILE)(
    'canonicalize rejects $name with the fixed InvalidArgumentError',
    ({ build }) => {
      const error = captureInvalidArgumentError(() =>
        canonicalizeBotApplicationOutcomeEvidence(build()),
      );

      expect(error.code).toBe(INVALID_OUTCOME_REQUEST_CODE);
    },
  );

  it.each(HOSTILE)(
    'hash rejects $name with the fixed InvalidArgumentError',
    ({ build }) => {
      const error = captureInvalidArgumentError(() =>
        hashBotApplicationOutcomeEvidence(build()),
      );

      expect(error.code).toBe(INVALID_OUTCOME_REQUEST_CODE);
    },
  );

  it('canonicalize rejects an accessor outcome key without invoking its getter', () => {
    let getterInvoked = false;
    const raw = parseBotApplicationOutcomeRequest(acceptedBody());
    Object.defineProperty(raw, 'outcome', {
      get() {
        getterInvoked = true;
        throw new Error('accessor-secret');
      },
      enumerable: true,
      configurable: true,
    });

    expect(() => canonicalizeBotApplicationOutcomeEvidence(raw)).toThrow(
      InvalidArgumentError,
    );
    expect(getterInvoked).toBe(false);
  });

  it('hash rejects an accessor outcome key without invoking its getter', () => {
    let getterInvoked = false;
    const raw = parseBotApplicationOutcomeRequest(staleBody());
    Object.defineProperty(raw, 'outcome', {
      get() {
        getterInvoked = true;
        throw new Error('accessor-secret');
      },
      enumerable: true,
      configurable: true,
    });

    expect(() => hashBotApplicationOutcomeEvidence(raw)).toThrow(
      InvalidArgumentError,
    );
    expect(getterInvoked).toBe(false);
  });

  it('canonicalize rejects a throwing Proxy ownKeys trap with the fixed error', () => {
    const secret = 'ownKeys-trap-secret';
    const proxy = new Proxy(parseBotApplicationOutcomeRequest(acceptedBody()), {
      ownKeys() {
        throw new Error(secret);
      },
    });

    const error = captureInvalidArgumentError(() =>
      canonicalizeBotApplicationOutcomeEvidence(proxy),
    );

    expect(error.code).toBe(INVALID_OUTCOME_REQUEST_CODE);
    expect(error.message).not.toContain(secret);
    expect(
      JSON.stringify(error, Object.getOwnPropertyNames(error)),
    ).not.toContain(secret);
  });

  it('hash rejects a throwing Proxy ownKeys trap with the fixed error', () => {
    const secret = 'ownKeys-trap-secret';
    const proxy = new Proxy(parseBotApplicationOutcomeRequest(staleBody()), {
      ownKeys() {
        throw new Error(secret);
      },
    });

    const error = captureInvalidArgumentError(() =>
      hashBotApplicationOutcomeEvidence(proxy),
    );

    expect(error.code).toBe(INVALID_OUTCOME_REQUEST_CODE);
    expect(error.message).not.toContain(secret);
  });

  it('never invokes a Proxy get trap in canonicalize or hash', () => {
    let getInvoked = false;
    const target = parseBotApplicationOutcomeRequest(acceptedBody());
    const proxy = new Proxy(target, {
      get(inner, property) {
        getInvoked = true;
        return Reflect.get(inner, property) as unknown;
      },
    });

    expect(canonicalizeBotApplicationOutcomeEvidence(proxy)).toEqual(
      canonicalizeBotApplicationOutcomeEvidence(target),
    );
    expect(hashBotApplicationOutcomeEvidence(proxy)).toBe(
      hashBotApplicationOutcomeEvidence(target),
    );
    expect(getInvoked).toBe(false);
  });

  it('does not reflect the rejected value in the error', () => {
    const secret = 'PII-secret-42';
    const raw = withOwnKey(
      parseBotApplicationOutcomeRequest(acceptedBody()),
      'evidenceCode',
      secret,
    );

    const canonicalizeError = captureInvalidArgumentError(() =>
      canonicalizeBotApplicationOutcomeEvidence(raw),
    );
    const hashError = captureInvalidArgumentError(() =>
      hashBotApplicationOutcomeEvidence(raw),
    );

    for (const error of [canonicalizeError, hashError]) {
      expect(error.message).not.toContain(secret);
      expect(
        JSON.stringify(error, Object.getOwnPropertyNames(error)),
      ).not.toContain(secret);
    }
  });
});

describe('evidence helpers accept raw JS input', () => {
  /** Raw, never-parsed bodies typed as `unknown`, exactly as an adapter sends them. */
  const RAW_FORBIDDEN: readonly { name: string; raw: unknown }[] = [
    {
      name: 'evidenceCode:null on PROVIDER_ACCEPTED',
      raw: { ...acceptedBody(), evidenceCode: null },
    },
    {
      name: 'extra actor/source keys on DELIVERY_UNKNOWN',
      raw: { ...unknownBody(), actor: 'smuggled-actor', source: 'smuggled' },
    },
    {
      name: 'STALE carrying attemptedAt:null',
      raw: { ...staleBody(), attemptedAt: null },
    },
    {
      name: 'DELIVERY_UNKNOWN carrying providerAcceptedObservedAt:null',
      raw: { ...unknownBody(), providerAcceptedObservedAt: null },
    },
  ];

  it.each(RAW_FORBIDDEN)('canonicalize rejects raw $name', ({ raw }) => {
    const error = captureInvalidArgumentError(() =>
      canonicalizeBotApplicationOutcomeEvidence(raw),
    );

    expect(error.code).toBe(INVALID_OUTCOME_REQUEST_CODE);
  });

  it.each(RAW_FORBIDDEN)('hash rejects raw $name', ({ raw }) => {
    const error = captureInvalidArgumentError(() =>
      hashBotApplicationOutcomeEvidence(raw),
    );

    expect(error.code).toBe(INVALID_OUTCOME_REQUEST_CODE);
  });

  it.each([
    ['PROVIDER_ACCEPTED', acceptedBody()],
    ['PROVIDER_ACCEPTED_LATE', lateBody()],
    ['DELIVERY_UNKNOWN', unknownBody()],
    ['DELIVERY_UNKNOWN with ID', unknownWithIdBody()],
    ['STALE', staleBody()],
  ])(
    'accepts well-formed raw %s identically to its parsed form',
    (_name, raw) => {
      const parsed = parseBotApplicationOutcomeRequest(raw);

      expect(canonicalizeBotApplicationOutcomeEvidence(raw)).toEqual(
        canonicalizeBotApplicationOutcomeEvidence(parsed),
      );
      expect(hashBotApplicationOutcomeEvidence(raw)).toBe(
        hashBotApplicationOutcomeEvidence(parsed),
      );
    },
  );

  it('keeps the pinned golden digests for raw input', () => {
    expect(hashBotApplicationOutcomeEvidence(acceptedBody())).toBe(
      'cc7534e067b71d1fc099250b65cab69dd714f1ec7b8c389d8ab8974c7e836831',
    );
    expect(hashBotApplicationOutcomeEvidence(staleBody())).toBe(
      'b623f85e54953edac8a33a25f84c8fdbe9c7baae60bdb4fe3d05d550c99ed9f0',
    );
    expect(hashBotApplicationOutcomeEvidence(unknownBody())).toBe(
      '184f50938342cad54adbabf50f8ebb684135f3fb080ff2f356632d64b229d750',
    );
  });

  it('does not mutate or alias the raw input', () => {
    const raw: Record<string, unknown> = acceptedBody();
    const snapshot: Record<string, unknown> = { ...raw };
    Object.freeze(raw);

    const projected = canonicalizeBotApplicationOutcomeEvidence(raw);
    const hash = hashBotApplicationOutcomeEvidence(raw);

    expect(raw).toEqual(snapshot);
    expect(hash).toHaveLength(64);
    expect(projected).not.toBe(raw);
    expect(Object.keys(projected)).toEqual([...ACCEPTED_KEY_ORDER]);
  });
});

type DeliveryUnknownForbidsAcceptedAt =
  'providerAcceptedObservedAt' extends keyof DeliveryUnknownRequest
    ? never
    : true;
type StaleForbidsAttemptedAt = 'attemptedAt' extends keyof StaleRequest
  ? never
  : true;
type StaleForbidsProviderMessageId =
  'providerMessageId' extends keyof StaleRequest ? never : true;
type StaleForbidsAcceptedAt =
  'providerAcceptedObservedAt' extends keyof StaleRequest ? never : true;

describe('parseBotApplicationOutcomeRequest types', () => {
  it('declares no forbidden evidence keys on DELIVERY_UNKNOWN/STALE', () => {
    const unknownGuard: DeliveryUnknownForbidsAcceptedAt = true;
    const attemptedGuard: StaleForbidsAttemptedAt = true;
    const messageGuard: StaleForbidsProviderMessageId = true;
    const acceptedGuard: StaleForbidsAcceptedAt = true;

    expect([unknownGuard, attemptedGuard, messageGuard, acceptedGuard]).toEqual(
      [true, true, true, true],
    );
  });

  it('accepts the exact literal variant shapes via satisfies', () => {
    const accepted = {
      attemptId: ATTEMPT_ID,
      expectedResolutionVersion: 2,
      outcome: PROVIDER_ACCEPTED,
      attemptedAt: ATTEMPTED_AT,
      providerMessageId: PROVIDER_MESSAGE_ID,
      providerAcceptedObservedAt: ACCEPTED_OBSERVED_AT,
    } satisfies ProviderAcceptedRequest;
    const late = {
      attemptId: ATTEMPT_ID,
      expectedResolutionVersion: 2,
      outcome: PROVIDER_ACCEPTED_LATE,
      attemptedAt: LATE_ATTEMPTED_AT,
      providerMessageId: PROVIDER_MESSAGE_ID,
      providerAcceptedObservedAt: LATE_ACCEPTED_OBSERVED_AT,
    } satisfies ProviderAcceptedLateRequest;
    const unknown = {
      attemptId: ATTEMPT_ID,
      expectedResolutionVersion: 7,
      outcome: DELIVERY_UNKNOWN,
      attemptedAt: ATTEMPTED_AT,
    } satisfies DeliveryUnknownRequest;
    const stale = {
      attemptId: ATTEMPT_ID,
      expectedResolutionVersion: 2,
      outcome: STALE,
    } satisfies StaleRequest;

    expect(accepted.outcome).toBe(PROVIDER_ACCEPTED);
    expect(late.outcome).toBe(PROVIDER_ACCEPTED_LATE);
    expect(
      Object.prototype.hasOwnProperty.call(unknown, 'providerMessageId'),
    ).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(stale, 'attemptedAt')).toBe(
      false,
    );
  });

  it('discriminates the parsed union by outcome', () => {
    const parsed = parseBotApplicationOutcomeRequest(lateBody());

    if (parsed.outcome === PROVIDER_ACCEPTED_LATE) {
      expect(parsed.providerAcceptedObservedAt).toBe(LATE_ACCEPTED_OBSERVED_AT);
    } else {
      throw new Error('expected the LATE variant');
    }
  });
});
