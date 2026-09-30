/**
 * HD-04c1 — `parseResolveHumanDecisionRequest` spec.
 *
 * Proves the human resolve body is parsed as an EXACT discriminated union:
 * only the variant's keys survive, authority/unknown keys are rejected rather
 * than stripped, the negative variant never carries `restockDays`, the numeric
 * bounds reject coercion, and `resolutionRequestId` matches the HD-02a UUID
 * policy. Own-key integrity additionally rejects non-enumerable and symbol
 * extras, rejects accessor/required-non-data keys without invoking them, and
 * converts throwing Proxy traps to the fixed error. Duplicate JSON keys are
 * outside this boundary (undetectable after `JSON.parse`). All rejections are
 * value-free.
 *
 * Approved design (read-only):
 * `houndfe-chatbot-human-decisions/docs/human-decisions-contract-v1.md`.
 */
import { InvalidArgumentError } from '../../../shared/domain/domain-error';
import { EXPIRATION_TEXT_MAX_LENGTH } from '../../domain/expiration-text';
import { normalizeRestockRequest } from '../../domain/restock-request-canonicalizer';
import {
  INVALID_RESOLVE_REQUEST_CODE,
  parseExpirationResolveHumanDecisionRequest,
  parseResolveHumanDecisionRequest,
  RESOLVE_PROVIDE_EXPIRATION_TEXT,
  RESOLVE_PROVIDE_RESTOCK_ESTIMATE,
  RESOLVE_REPORT_EXPIRATION_UNAVAILABLE,
  RESOLVE_REPORT_RESTOCK_ESTIMATE_UNAVAILABLE,
  RESOLVE_RESTOCK_DAYS_MAX,
  RESOLVE_RESTOCK_DAYS_MIN,
  type ResolveExpirationHumanDecisionRequest,
  type ResolveProvideExpirationTextRequest,
  type ResolveProvideRestockEstimateRequest,
  type ResolveReportExpirationUnavailableRequest,
  type ResolveReportRestockEstimateUnavailableRequest,
} from './resolve-human-decision.request';

const RESOLUTION_REQUEST_ID = '3f1c1b7a-9c2e-4d5f-8a6b-1c2d3e4f5a6b';
const UUID_V1 = 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6';
const UUID_V7 = '0192a1b2-c3d4-7e5f-8a6b-1c2d3e4f5a6b';
const UUID_V8 = '3f1c1b7a-9c2e-8d5f-8a6b-1c2d3e4f5a6b';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const VERSION_0_UUID = '3f1c1b7a-9c2e-0d5f-8a6b-1c2d3e4f5a6b';
const VERSION_9_UUID = '3f1c1b7a-9c2e-9d5f-8a6b-1c2d3e4f5a6b';
const INVALID_VARIANT_UUID = '3f1c1b7a-9c2e-4d5f-0a6b-1c2d3e4f5a6b';
const PRODUCT_ID = '8f14e45f-ceea-4e42-9f62-1a2b3c4d5e6f';

/** Keys an untrusted body might try to smuggle in; ALL must be rejected. */
const AUTHORITY_KEYS = [
  'tenantId',
  'reviewerId',
  'resolvedAt',
  'applyBefore',
  'providerMessageId',
  'outcome',
  'actor',
  'source',
  'credentialId',
  'branchId',
  'reason',
  'note',
] as const;

function positiveBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    action: RESOLVE_PROVIDE_RESTOCK_ESTIMATE,
    restockDays: 7,
    expectedVersion: 1,
    resolutionRequestId: RESOLUTION_REQUEST_ID,
    ...overrides,
  };
}

function negativeBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    action: RESOLVE_REPORT_RESTOCK_ESTIMATE_UNAVAILABLE,
    expectedVersion: 1,
    resolutionRequestId: RESOLUTION_REQUEST_ID,
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

function expectInvalid(value: unknown): void {
  expect(() => parseResolveHumanDecisionRequest(value)).toThrow(
    InvalidArgumentError,
  );
}

function captureError(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the parser to reject the value');
}

function actionOnlyBody(action: unknown): Record<string, unknown> {
  return {
    action,
    expectedVersion: 1,
    resolutionRequestId: RESOLUTION_REQUEST_ID,
  };
}

const INVALID_RESTOCK_DAYS: readonly unknown[] = [
  0,
  -1,
  RESOLVE_RESTOCK_DAYS_MAX + 1,
  1.5,
  Number.MAX_SAFE_INTEGER + 1,
  NaN,
  Infinity,
  -Infinity,
  '7',
  null,
  true,
  [],
  {},
];

const INVALID_EXPECTED_VERSIONS: readonly unknown[] = [
  0,
  -1,
  1.5,
  Number.MAX_SAFE_INTEGER + 1,
  NaN,
  Infinity,
  '1',
  null,
  true,
  [],
  {},
];

const INVALID_RESOLUTION_REQUEST_IDS: readonly unknown[] = [
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

describe('parseResolveHumanDecisionRequest', () => {
  it('parses the exact positive variant with its four keys', () => {
    const parsed = parseResolveHumanDecisionRequest(positiveBody());

    expect(parsed).toEqual({
      action: RESOLVE_PROVIDE_RESTOCK_ESTIMATE,
      restockDays: 7,
      expectedVersion: 1,
      resolutionRequestId: RESOLUTION_REQUEST_ID,
    });
    expect(Object.keys(parsed)).toEqual([
      'action',
      'restockDays',
      'expectedVersion',
      'resolutionRequestId',
    ]);
  });

  it('parses the exact negative variant with NO restockDays own property', () => {
    const parsed = parseResolveHumanDecisionRequest(negativeBody());

    expect(parsed).toEqual({
      action: RESOLVE_REPORT_RESTOCK_ESTIMATE_UNAVAILABLE,
      expectedVersion: 1,
      resolutionRequestId: RESOLUTION_REQUEST_ID,
    });
    expect(Object.keys(parsed)).toEqual([
      'action',
      'expectedVersion',
      'resolutionRequestId',
    ]);
    expect(Object.prototype.hasOwnProperty.call(parsed, 'restockDays')).toBe(
      false,
    );
    expect('restockDays' in parsed).toBe(false);
  });

  it.each([RESOLVE_RESTOCK_DAYS_MIN, RESOLVE_RESTOCK_DAYS_MAX])(
    'accepts the inclusive restockDays boundary %i',
    (days) => {
      expect(
        parseResolveHumanDecisionRequest(positiveBody({ restockDays: days })),
      ).toMatchObject({ restockDays: days });
    },
  );

  it.each(INVALID_RESTOCK_DAYS)(
    'rejects invalid restockDays %p (no string coercion)',
    (days) => {
      expectInvalid(positiveBody({ restockDays: days }));
    },
  );

  it.each([1, 2, 7, 9, 123_456])(
    'accepts a positive expectedVersion %i (never hardcoded to 1; stale reaches CAS)',
    (version) => {
      expect(
        parseResolveHumanDecisionRequest(
          positiveBody({ expectedVersion: version }),
        ).expectedVersion,
      ).toBe(version);
    },
  );

  it.each(INVALID_EXPECTED_VERSIONS)(
    'rejects invalid expectedVersion %p',
    (version) => {
      expectInvalid(positiveBody({ expectedVersion: version }));
    },
  );

  it.each([UUID_V1, RESOLUTION_REQUEST_ID, UUID_V7, UUID_V8])(
    'accepts canonical RFC 4122 v1-v8 UUID %s',
    (uuid) => {
      expect(
        parseResolveHumanDecisionRequest(
          negativeBody({ resolutionRequestId: uuid }),
        ).resolutionRequestId,
      ).toBe(uuid);
    },
  );

  it.each(INVALID_RESOLUTION_REQUEST_IDS)(
    'rejects nil/invalid resolutionRequestId %p',
    (uuid) => {
      expectInvalid(negativeBody({ resolutionRequestId: uuid }));
    },
  );

  it('trims and lowercases resolutionRequestId like HD-02a', () => {
    const raw = `  ${RESOLUTION_REQUEST_ID.toUpperCase()}  `;

    expect(
      parseResolveHumanDecisionRequest(
        negativeBody({ resolutionRequestId: raw }),
      ).resolutionRequestId,
    ).toBe(RESOLUTION_REQUEST_ID);
  });

  it('matches the HD-02a canonicalizer UUID policy for the same input', () => {
    const raw = `  ${RESOLUTION_REQUEST_ID.toUpperCase()}  `;
    const canonical = normalizeRestockRequest({
      tenantId: 'tenant-1',
      sourceRequestId: raw,
      productId: PRODUCT_ID,
      productName: 'Filtro de aceite',
      submittedCredentialId: 'credential-1',
    });

    expect(
      parseResolveHumanDecisionRequest(
        negativeBody({ resolutionRequestId: raw }),
      ).resolutionRequestId,
    ).toBe(canonical.sourceRequestId);
  });

  it.each(AUTHORITY_KEYS)(
    'rejects the authority/unknown key %s on either variant',
    (key) => {
      expectInvalid(positiveBody({ [key]: 'smuggled' }));
      expectInvalid(negativeBody({ [key]: 'smuggled' }));
    },
  );

  it('rejects an arbitrary unknown free-text key', () => {
    expectInvalid(positiveBody({ freeText: 'hola' }));
    expectInvalid(negativeBody({ freeText: 'hola' }));
  });

  it.each(['action', 'restockDays', 'expectedVersion', 'resolutionRequestId'])(
    'rejects a positive body missing %s',
    (key) => {
      expectInvalid(omit(positiveBody(), [key]));
    },
  );

  it.each(['action', 'expectedVersion', 'resolutionRequestId'])(
    'rejects a negative body missing %s',
    (key) => {
      expectInvalid(omit(negativeBody(), [key]));
    },
  );

  it.each([null, undefined, 7, 0])(
    'rejects a negative body carrying restockDays %p',
    (days) => {
      expectInvalid({ ...negativeBody(), restockDays: days });
    },
  );

  it.each([
    null,
    'PROVIDE_RESTOCK_ESTIMATE',
    42,
    true,
    [],
    [{ action: RESOLVE_PROVIDE_RESTOCK_ESTIMATE }],
  ])('rejects a non-object body %p', (value) => {
    expectInvalid(value);
  });

  it('rejects an undefined body', () => {
    expectInvalid(undefined);
  });

  it.each([
    '',
    'PROVIDE_RESTOCK_ESTIMATE ',
    ' PROVIDE_RESTOCK_ESTIMATE',
    'provide_restock_estimate',
    'NO_RESTOCK',
    null,
    1,
    true,
    {},
    [],
  ])('rejects an invalid action %p', (action) => {
    expectInvalid(actionOnlyBody(action));
  });

  it('rejects an undefined action', () => {
    expectInvalid(actionOnlyBody(undefined));
  });

  it('fails value-free with one fixed message and code', () => {
    const secret = 'PII-secret-42';
    const first = captureError(() =>
      parseResolveHumanDecisionRequest(
        positiveBody({ restockDays: secret, expectedVersion: secret }),
      ),
    );
    const second = captureError(() =>
      parseResolveHumanDecisionRequest(
        negativeBody({ resolutionRequestId: secret, note: secret }),
      ),
    );

    expect(first).toBeInstanceOf(InvalidArgumentError);
    expect(second).toBeInstanceOf(InvalidArgumentError);
    expect(first.message).toBe(second.message);
    expect((first as InvalidArgumentError).code).toBe(
      INVALID_RESOLVE_REQUEST_CODE,
    );
    expect(first.message).not.toContain(secret);
    expect(second.message).not.toContain(secret);
    expect(
      JSON.stringify(second, Object.getOwnPropertyNames(second)),
    ).not.toContain(secret);
    expect((first as { value?: unknown }).value).toBeUndefined();
  });

  it('does not mutate or alias the input body', () => {
    const body = positiveBody({ restockDays: 30 });
    const snapshot: Record<string, unknown> = { ...body };
    Object.freeze(body);

    const parsed = parseResolveHumanDecisionRequest(body);

    expect(body).toEqual(snapshot);
    expect(parsed).not.toBe(body);
    expect(parsed).toEqual(snapshot);
  });
});

describe('parseResolveHumanDecisionRequest own-key integrity', () => {
  it('rejects an extra non-enumerable own key that Object.keys would hide', () => {
    const body = positiveBody();
    Object.defineProperty(body, 'smuggled', {
      value: 'x',
      enumerable: false,
      writable: true,
      configurable: true,
    });

    expectInvalid(body);
  });

  it('rejects an extra symbol own key', () => {
    const body = positiveBody();
    Reflect.set(body, Symbol('smuggled'), 'x');

    expectInvalid(body);
  });

  it('rejects an accessor value key without invoking its getter', () => {
    let getterInvoked = false;
    const body = positiveBody();
    Object.defineProperty(body, 'restockDays', {
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

  it('rejects an accessor action key without invoking its getter', () => {
    let getterInvoked = false;
    const body = positiveBody();
    Object.defineProperty(body, 'action', {
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
    const body = positiveBody();
    Object.defineProperty(body, 'action', {
      value: RESOLVE_PROVIDE_RESTOCK_ESTIMATE,
      enumerable: false,
      writable: true,
      configurable: true,
    });

    expectInvalid(body);
  });

  it('accepts an exact null-prototype body', () => {
    const body = Object.create(null) as Record<string, unknown>;
    body.action = RESOLVE_PROVIDE_RESTOCK_ESTIMATE;
    body.restockDays = 7;
    body.expectedVersion = 1;
    body.resolutionRequestId = RESOLUTION_REQUEST_ID;

    expect(parseResolveHumanDecisionRequest(body)).toEqual({
      action: RESOLVE_PROVIDE_RESTOCK_ESTIMATE,
      restockDays: 7,
      expectedVersion: 1,
      resolutionRequestId: RESOLUTION_REQUEST_ID,
    });
  });

  it('converts a throwing Proxy ownKeys trap to the fixed value-free error', () => {
    const secret = 'ownKeys-trap-secret';
    const proxy = new Proxy(positiveBody(), {
      ownKeys() {
        throw new Error(secret);
      },
    });

    const error = captureError(() => parseResolveHumanDecisionRequest(proxy));

    expect(error).toBeInstanceOf(InvalidArgumentError);
    expect((error as InvalidArgumentError).code).toBe(
      INVALID_RESOLVE_REQUEST_CODE,
    );
    expect(error.message).not.toContain(secret);
  });

  it('converts a throwing Proxy getOwnPropertyDescriptor trap to the fixed error', () => {
    const secret = 'descriptor-trap-secret';
    const proxy = new Proxy(positiveBody(), {
      getOwnPropertyDescriptor() {
        throw new Error(secret);
      },
    });

    const error = captureError(() => parseResolveHumanDecisionRequest(proxy));

    expect(error).toBeInstanceOf(InvalidArgumentError);
    expect(error.message).not.toContain(secret);
  });

  it('replaces a Proxy ownKeys trap throwing InvalidArgumentError with the fixed error', () => {
    const sentinel = 'secret-sentinel';
    const proxy = new Proxy(positiveBody(), {
      ownKeys() {
        throw new InvalidArgumentError(sentinel, 'EVIL_CODE');
      },
    });

    const fixed = captureError(() => parseResolveHumanDecisionRequest(null));
    const error = captureError(() => parseResolveHumanDecisionRequest(proxy));

    expect(error).toBeInstanceOf(InvalidArgumentError);
    expect(error.message).toBe(fixed.message);
    expect((error as InvalidArgumentError).code).toBe(
      INVALID_RESOLVE_REQUEST_CODE,
    );
    expect(error.message).not.toContain(sentinel);
    expect(
      JSON.stringify(error, Object.getOwnPropertyNames(error)),
    ).not.toContain(sentinel);
  });

  it('replaces a Proxy getOwnPropertyDescriptor trap throwing InvalidArgumentError with the fixed error', () => {
    const sentinel = 'secret-sentinel';
    const proxy = new Proxy(positiveBody(), {
      getOwnPropertyDescriptor() {
        throw new InvalidArgumentError(sentinel, 'EVIL_CODE');
      },
    });

    const fixed = captureError(() => parseResolveHumanDecisionRequest(null));
    const error = captureError(() => parseResolveHumanDecisionRequest(proxy));

    expect(error).toBeInstanceOf(InvalidArgumentError);
    expect(error.message).toBe(fixed.message);
    expect((error as InvalidArgumentError).code).toBe(
      INVALID_RESOLVE_REQUEST_CODE,
    );
    expect(
      JSON.stringify(error, Object.getOwnPropertyNames(error)),
    ).not.toContain(sentinel);
  });

  it('never invokes a Proxy get trap for required values', () => {
    let getInvoked = false;
    const proxy = new Proxy(positiveBody(), {
      get(target, property) {
        getInvoked = true;
        return Reflect.get(target, property) as unknown;
      },
    });

    expect(parseResolveHumanDecisionRequest(proxy)).toEqual(positiveBody());
    expect(getInvoked).toBe(false);
  });
});

type NegativeVariantForbidsRestockDays =
  'restockDays' extends keyof ResolveReportRestockEstimateUnavailableRequest
    ? never
    : true;

describe('parseResolveHumanDecisionRequest types', () => {
  it('declares no restockDays on the negative variant type', () => {
    const guard: NegativeVariantForbidsRestockDays = true;

    expect(guard).toBe(true);
  });

  it('accepts the exact literal variant shapes via satisfies', () => {
    const positive = {
      action: RESOLVE_PROVIDE_RESTOCK_ESTIMATE,
      restockDays: 7,
      expectedVersion: 1,
      resolutionRequestId: RESOLUTION_REQUEST_ID,
    } satisfies ResolveProvideRestockEstimateRequest;
    const negative = {
      action: RESOLVE_REPORT_RESTOCK_ESTIMATE_UNAVAILABLE,
      expectedVersion: 1,
      resolutionRequestId: RESOLUTION_REQUEST_ID,
    } satisfies ResolveReportRestockEstimateUnavailableRequest;

    expect(positive.restockDays).toBe(7);
    expect(Object.prototype.hasOwnProperty.call(negative, 'restockDays')).toBe(
      false,
    );
  });
});

type NegativeExpirationVariantForbidsText =
  'expirationText' extends keyof ResolveReportExpirationUnavailableRequest
    ? never
    : true;

describe('parseExpirationResolveHumanDecisionRequest (EXPIRATION)', () => {
  const ok = (extra: Record<string, unknown>): Record<string, unknown> => ({
    action: RESOLVE_PROVIDE_EXPIRATION_TEXT,
    expirationText: 'Lote 2026-A vence en agosto',
    expectedVersion: 1,
    resolutionRequestId: RESOLUTION_REQUEST_ID,
    ...extra,
  });
  const bad = (extra: Record<string, unknown>): Record<string, unknown> => ({
    action: RESOLVE_REPORT_EXPIRATION_UNAVAILABLE,
    expectedVersion: 1,
    resolutionRequestId: RESOLUTION_REQUEST_ID,
    ...extra,
  });
  const parse = parseExpirationResolveHumanDecisionRequest;

  function expectInvalid(value: unknown): void {
    expect(() => parse(value)).toThrow(InvalidArgumentError);
  }

  it('parses PROVIDE_EXPIRATION_TEXT exactly, normalizing expirationText', () => {
    expect(
      parse(ok({ expirationText: '  Cafe\u0301   de   filtro  ' })),
    ).toEqual({
      action: RESOLVE_PROVIDE_EXPIRATION_TEXT,
      expirationText: 'Caf\u00e9 de filtro',
      expectedVersion: 1,
      resolutionRequestId: RESOLUTION_REQUEST_ID,
    });
  });

  it('parses REPORT_EXPIRATION_UNAVAILABLE with NO expirationText', () => {
    const parsed = parse(bad({}));

    expect(parsed).toEqual({
      action: RESOLVE_REPORT_EXPIRATION_UNAVAILABLE,
      expectedVersion: 1,
      resolutionRequestId: RESOLUTION_REQUEST_ID,
    });
    expect(Object.prototype.hasOwnProperty.call(parsed, 'expirationText')).toBe(
      false,
    );
  });

  it('accepts the 500 bound and rejects 501 without truncating', () => {
    const atLimit = 'a'.repeat(EXPIRATION_TEXT_MAX_LENGTH);

    expect(parse(ok({ expirationText: atLimit }))).toMatchObject({
      expirationText: atLimit,
    });
    expectInvalid(
      ok({ expirationText: 'a'.repeat(EXPIRATION_TEXT_MAX_LENGTH + 1) }),
    );
  });

  it('rejects control characters and invalid expirationText values', () => {
    const controls = ['line\nbreak', 'tab\there', 'cr\rhere', 'del\u007f'];

    for (const text of [
      ...controls,
      undefined,
      null,
      7,
      true,
      {},
      [],
      '',
      '   ',
    ]) {
      expectInvalid(ok({ expirationText: text }));
    }
  });

  it('accepts canonical trimmed UUIDs and rejects invalid ones', () => {
    for (const uuid of [UUID_V1, RESOLUTION_REQUEST_ID, UUID_V7, UUID_V8]) {
      const raw = `  ${uuid.toUpperCase()}  `;

      expect(parse(ok({ resolutionRequestId: raw }))).toMatchObject({
        resolutionRequestId: uuid,
      });
      expect(parse(bad({ resolutionRequestId: raw }))).toMatchObject({
        resolutionRequestId: uuid,
      });
    }
    for (const uuid of INVALID_RESOLUTION_REQUEST_IDS) {
      expectInvalid(bad({ resolutionRequestId: uuid }));
    }
  });

  it('accepts positive versions and rejects invalid ones', () => {
    for (const version of [1, 2, 7, 123_456]) {
      expect(parse(ok({ expectedVersion: version }))).toMatchObject({
        expectedVersion: version,
      });
    }
    for (const version of INVALID_EXPECTED_VERSIONS) {
      expectInvalid(ok({ expectedVersion: version }));
    }
  });

  it('rejects every extra/authority key on either variant', () => {
    for (const key of AUTHORITY_KEYS) {
      expectInvalid(ok({ [key]: 'x' }));
      expectInvalid(bad({ [key]: 'x' }));
    }
  });

  it('rejects restockDays smuggled into either variant', () => {
    expectInvalid(ok({ restockDays: 7 }));
    expectInvalid(bad({ restockDays: 7 }));
  });

  it('rejects a body missing any required key', () => {
    for (const key of [
      'action',
      'expirationText',
      'expectedVersion',
      'resolutionRequestId',
    ]) {
      expectInvalid(omit(ok({}), [key]));
    }
    for (const key of ['action', 'expectedVersion', 'resolutionRequestId']) {
      expectInvalid(omit(bad({}), [key]));
    }
  });

  it.each([null, undefined, '', 'hola'])(
    'rejects UNAVAILABLE carrying expirationText %p',
    (text) => {
      expectInvalid(bad({ expirationText: text }));
    },
  );

  it.each([null, undefined, 7, true, [], [{}]])(
    'rejects the non-object EXP body %p',
    (value) => {
      expectInvalid(value);
    },
  );

  it.each([
    '',
    'provide_expiration_text',
    RESOLVE_PROVIDE_RESTOCK_ESTIMATE,
    RESOLVE_REPORT_RESTOCK_ESTIMATE_UNAVAILABLE,
    true,
    {},
  ])('rejects the invalid EXP action %p (RESTOCK included)', (action) => {
    expectInvalid({
      action,
      expectedVersion: 1,
      resolutionRequestId: RESOLUTION_REQUEST_ID,
    });
  });

  it('fails value-free with one fixed message and code', () => {
    const secret = 'PII-secret-42';
    const errors = [
      captureError(() => parse(ok({ expirationText: `bad\n${secret}` }))),
      captureError(() =>
        parse(bad({ resolutionRequestId: secret, note: secret })),
      ),
    ];

    for (const error of errors) {
      expect(error).toBeInstanceOf(InvalidArgumentError);
      expect(error.message).toBe(errors[0].message);
      expect(error.message).not.toContain(secret);
      expect(
        JSON.stringify(error, Object.getOwnPropertyNames(error)),
      ).not.toContain(secret);
    }
    expect((errors[0] as InvalidArgumentError).code).toBe(
      INVALID_RESOLVE_REQUEST_CODE,
    );
  });

  it('leaves the RESTOCK parser behavior unchanged', () => {
    expect(parseResolveHumanDecisionRequest(positiveBody()).action).toBe(
      RESOLVE_PROVIDE_RESTOCK_ESTIMATE,
    );
    expectInvalid(positiveBody());
    expectInvalid(negativeBody());
  });

  it('types: UNAVAILABLE forbids expirationText and literals satisfy', () => {
    const guard: NegativeExpirationVariantForbidsText = true;
    const unavailable = {
      action: RESOLVE_REPORT_EXPIRATION_UNAVAILABLE,
      expectedVersion: 1,
      resolutionRequestId: RESOLUTION_REQUEST_ID,
    } satisfies ResolveReportExpirationUnavailableRequest;
    const union: ResolveExpirationHumanDecisionRequest = {
      action: RESOLVE_PROVIDE_EXPIRATION_TEXT,
      expirationText: 'Lote 2026-A',
      expectedVersion: 1,
      resolutionRequestId: RESOLUTION_REQUEST_ID,
    } satisfies ResolveProvideExpirationTextRequest;

    expect(guard).toBe(true);
    expect(union.action).toBe(RESOLVE_PROVIDE_EXPIRATION_TEXT);
    expect(
      Object.prototype.hasOwnProperty.call(unavailable, 'expirationText'),
    ).toBe(false);
  });
});
