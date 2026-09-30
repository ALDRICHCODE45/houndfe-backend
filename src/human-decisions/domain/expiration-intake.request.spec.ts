/**
 * HD-EXP-01a — `parseExpirationIntakeRequest` boundary and canonical identity.
 * Covers the EXACT four-key body, HD-02a UUID policy, retained original bytes,
 * own-key/Proxy/getter integrity, 5th-key rejection, the parse→canonicalize→
 * hash composition and a hash over ONLY the four normalized wire keys.
 */
import { createHash } from 'node:crypto';
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import {
  canonicalizeExpirationIntakeRequest,
  EXPIRATION_TYPE,
  hashExpirationIntakeIdentity,
  INVALID_EXPIRATION_REQUEST_CODE,
  parseExpirationIntakeRequest,
  type ExpirationIntakeIdentity,
} from './expiration-intake.request';

const SOURCE_REQUEST_ID = '3f1c1b7a-9c2e-4d5f-8a6b-1c2d3e4f5a6b';
const PRODUCT_ID = '8f14e45f-ceea-4e42-9f62-1a2b3c4d5e6f';
const VARIANT_ID = '550e8400-e29b-41d4-a716-446655440000';
const OTHER_ID = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

const PARSED = {
  sourceRequestId: SOURCE_REQUEST_ID,
  originalSourceRequestId: SOURCE_REQUEST_ID,
  type: EXPIRATION_TYPE,
  productId: PRODUCT_ID,
  variantId: VARIANT_ID,
};

function body(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sourceRequestId: SOURCE_REQUEST_ID,
    type: EXPIRATION_TYPE,
    productId: PRODUCT_ID,
    variantId: VARIANT_ID,
    ...overrides,
  };
}

function identity(
  raw: Record<string, unknown> = body(),
): ExpirationIntakeIdentity {
  return canonicalizeExpirationIntakeRequest(parseExpirationIntakeRequest(raw));
}

function hash(raw: Record<string, unknown> = body()): string {
  return hashExpirationIntakeIdentity(identity(raw));
}

function captureInvalid(value: unknown): InvalidArgumentError {
  try {
    parseExpirationIntakeRequest(value);
  } catch (error) {
    if (error instanceof InvalidArgumentError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected parseExpirationIntakeRequest to reject the value');
}

describe('parseExpirationIntakeRequest', () => {
  it('accepts the exact four-key body and an explicit null variant', () => {
    expect(parseExpirationIntakeRequest(body())).toEqual(PARSED);
    expect(parseExpirationIntakeRequest(body({ variantId: null }))).toEqual({
      ...PARSED,
      variantId: null,
    });
  });
  it.each(['sourceRequestId', 'type', 'productId', 'variantId'])(
    'rejects the missing required key %s',
    (key) => {
      const incomplete = body();
      delete incomplete[key];
      expect(captureInvalid(incomplete).code).toBe(
        INVALID_EXPIRATION_REQUEST_CODE,
      );
    },
  );
  it.each([
    'tenantId',
    'source',
    'credentialId',
    'submittedCredentialId',
    'supersedesDecisionId',
    'sku',
    'quantity',
    'note',
    'metadata',
    'originalSourceRequestId',
  ])('rejects the extra/authority or externally forbidden key %s', (key) => {
    expect(captureInvalid(body({ [key]: 'x' })).code).toBe(
      INVALID_EXPIRATION_REQUEST_CODE,
    );
  });
  it('rejects an explicit 5th metadata payload', () => {
    const metadata = { actorId: 'user-1', note: 'operator-note' };

    expect(captureInvalid(body({ metadata })).code).toBe(
      INVALID_EXPIRATION_REQUEST_CODE,
    );
  });
  it.each(['RESTOCK', 'PROVIDE_EXPIRATION_TEXT', 'expiration', '', 7])(
    'rejects the wrong type discriminant %p',
    (type) => {
      expect(captureInvalid(body({ type })).code).toBe(
        INVALID_EXPIRATION_REQUEST_CODE,
      );
    },
  );
  it('canonicalizes UUIDs and retains the original sourceRequestId bytes', () => {
    const raw = `  ${SOURCE_REQUEST_ID.toUpperCase()}  `;
    const parsed = parseExpirationIntakeRequest(
      body({ sourceRequestId: raw, productId: PRODUCT_ID.toUpperCase() }),
    );
    expect(parsed.sourceRequestId).toBe(SOURCE_REQUEST_ID);
    expect(parsed.originalSourceRequestId).toBe(raw);
    expect(parsed.productId).toBe(PRODUCT_ID);
  });
  it.each([
    { sourceRequestId: 'not-a-uuid' },
    { sourceRequestId: NIL_UUID },
    { productId: 'product-1' },
    { productId: NIL_UUID },
    { variantId: 'variant-1' },
    { variantId: NIL_UUID },
    { variantId: undefined },
    { variantId: '' },
  ])('rejects the invalid identifier %#', (override) => {
    expect(captureInvalid(body(override)).code).toBe(
      INVALID_EXPIRATION_REQUEST_CODE,
    );
  });
  it.each([undefined, null, 7, 'text', []])(
    'rejects the non-object body %p',
    (value) => {
      expect(captureInvalid(value).code).toBe(INVALID_EXPIRATION_REQUEST_CODE);
    },
  );
  it('fails value-free with one fixed code', () => {
    const secret = 'PII-secret-42';
    const error = captureInvalid(body({ productId: secret }));
    expect(error.code).toBe(INVALID_EXPIRATION_REQUEST_CODE);
    expect(error.message).not.toContain(secret);
    expect(
      JSON.stringify(error, Object.getOwnPropertyNames(error)),
    ).not.toContain(secret);
  });
  it('does not mutate or alias the input body', () => {
    const input = body();
    const snapshot = { ...input };
    Object.freeze(input);
    const parsed = parseExpirationIntakeRequest(input);
    expect(input).toEqual(snapshot);
    expect(parsed).not.toBe(input);
  });
});

describe('parseExpirationIntakeRequest own-key integrity', () => {
  it('rejects symbol, non-enumerable and hidden required own keys', () => {
    const symbolKey = body();
    Reflect.set(symbolKey, Symbol('smuggled'), 'x');
    const nonEnumerable = body();
    Reflect.defineProperty(nonEnumerable, 'smuggled', {
      value: 'x',
      enumerable: false,
    });
    const hiddenRequired = body();
    Reflect.defineProperty(hiddenRequired, 'type', {
      value: EXPIRATION_TYPE,
      enumerable: false,
    });
    expect(captureInvalid(symbolKey).code).toBe(
      INVALID_EXPIRATION_REQUEST_CODE,
    );
    expect(captureInvalid(nonEnumerable).code).toBe(
      INVALID_EXPIRATION_REQUEST_CODE,
    );
    expect(captureInvalid(hiddenRequired).code).toBe(
      INVALID_EXPIRATION_REQUEST_CODE,
    );
  });
  it('rejects an accessor key without invoking its getter', () => {
    let getterInvoked = false;
    const input = body();
    Object.defineProperty(input, 'productId', {
      get() {
        getterInvoked = true;
        throw new Error('accessor-secret');
      },
      enumerable: true,
      configurable: true,
    });
    expect(captureInvalid(input).code).toBe(INVALID_EXPIRATION_REQUEST_CODE);
    expect(getterInvoked).toBe(false);
  });
  it.each(['ownKeys', 'getOwnPropertyDescriptor'])(
    'converts a throwing Proxy %s trap to the fixed value-free error',
    (trap) => {
      const secret = `${trap}-trap-secret`;
      const proxy = new Proxy(body(), {
        [trap]() {
          throw new Error(secret);
        },
      });
      const error = captureInvalid(proxy);
      expect(error.code).toBe(INVALID_EXPIRATION_REQUEST_CODE);
      expect(error.message).not.toContain(secret);
    },
  );
  it('never invokes a Proxy get trap for any value', () => {
    let getInvoked = false;
    const proxy = new Proxy(body(), {
      get(target, property) {
        getInvoked = true;
        return Reflect.get(target, property) as unknown;
      },
    });
    expect(parseExpirationIntakeRequest(proxy)).toEqual(PARSED);
    expect(getInvoked).toBe(false);
  });
});

describe('canonicalizeExpirationIntakeRequest / hashExpirationIntakeIdentity', () => {
  it('composes parse → canonicalize → hash on the internal typed command', () => {
    const parsed = parseExpirationIntakeRequest(body());
    const projected = canonicalizeExpirationIntakeRequest(parsed);

    expect(projected).toEqual({
      productId: PRODUCT_ID,
      sourceRequestId: SOURCE_REQUEST_ID,
      type: EXPIRATION_TYPE,
      variantId: VARIANT_ID,
    });
    expect(hashExpirationIntakeIdentity(projected)).toBe(hash());
  });
  it('hashes the four sorted wire keys with a stable byte form', () => {
    const projected = identity();
    expect(Object.keys(projected)).toEqual([
      'productId',
      'sourceRequestId',
      'type',
      'variantId',
    ]);
    expect(hash()).toBe(
      createHash('sha256')
        .update(JSON.stringify(projected), 'utf8')
        .digest('hex'),
    );
    expect(hash()).toMatch(/^[0-9a-f]{64}$/);
  });
  it('is order-independent and excludes the retained original bytes', () => {
    const raw = `  ${SOURCE_REQUEST_ID.toUpperCase()}  `;
    const reversed = Object.fromEntries(Object.entries(body()).reverse());
    expect(hash(reversed)).toBe(hash());
    expect(identity(body({ sourceRequestId: raw }))).toEqual(identity());
    expect(hash(body({ sourceRequestId: raw }))).toBe(hash());
  });
  it.each([
    ['sourceRequestId', { sourceRequestId: OTHER_ID }],
    ['productId', { productId: OTHER_ID }],
    ['variantId', { variantId: null }],
  ])('changes the hash when %s changes', (_field, override) => {
    expect(hash(body(override))).not.toBe(hash());
  });
});
