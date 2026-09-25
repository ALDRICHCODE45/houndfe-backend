/**
 * HD-03a — RestockIntakeRequestDto spec.
 *
 * Exercises the SAME options the global `ValidationPipe` runs with
 * (`whitelist`, `forbidNonWhitelisted`) and documents the deliberate split
 * between boundary-structural validation (here) and HD-02a semantic
 * validation (normalization, calendar, pair rule, safeness re-check).
 */
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import { InvalidArgumentError } from '../../../shared/domain/domain-error';
import {
  canonicalizeRestockRequest,
  type RestockRequestInput,
} from '../../domain/restock-request-canonicalizer';
import { RestockIntakeRequestDto } from './restock-intake.request';

const SOURCE_REQUEST_ID = '3f1c1b7a-9c2e-4d5f-8a6b-1c2d3e4f5a6b';
const PRODUCT_ID = '8f14e45f-ceea-4e42-9f62-1a2b3c4d5e6f';
const VARIANT_ID = '550e8400-e29b-41d4-a716-446655440000';
const SUPERSEDES_ID = 'a1b2c3d4-e5f6-4789-8abc-def012345678';

/** Mirrors `main.ts` global pipe options (custom factory aside). */
const VALIDATE_OPTIONS = {
  whitelist: true,
  forbidNonWhitelisted: true,
  forbidUnknownValues: true,
} as const;

async function validateBody(body: unknown): Promise<ValidationError[]> {
  const instance = plainToInstance(RestockIntakeRequestDto, body);
  return validate(instance, VALIDATE_OPTIONS);
}

async function expectValid(body: unknown): Promise<void> {
  expect(await validateBody(body)).toEqual([]);
}

async function expectRejectedKey(
  body: unknown,
  property: string,
): Promise<ValidationError[]> {
  const errors = await validateBody(body);
  expect(errors.map((error) => error.property)).toContain(property);
  return errors;
}

/** Full bot body with every nullable field emitted explicitly as `null`. */
function validBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sourceRequestId: SOURCE_REQUEST_ID,
    type: 'RESTOCK',
    productId: PRODUCT_ID,
    productName: 'Filtro de aceite',
    variantId: null,
    sku: null,
    requestedQuantity: null,
    observedStockAtRequest: null,
    stockObservedAt: null,
    supersedesDecisionId: null,
    ...overrides,
  };
}

/** Required fields only; nullable fields omitted entirely. */
function requiredOnlyBody(): Record<string, unknown> {
  return {
    sourceRequestId: SOURCE_REQUEST_ID,
    type: 'RESTOCK',
    productId: PRODUCT_ID,
    productName: 'Filtro de aceite',
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

function canonicalInput(
  overrides: Partial<RestockRequestInput> = {},
): RestockRequestInput {
  return {
    tenantId: 'tenant-1',
    sourceRequestId: SOURCE_REQUEST_ID,
    productId: PRODUCT_ID,
    productName: 'Filtro de aceite',
    submittedCredentialId: 'credential-1',
    ...overrides,
  };
}

describe('RestockIntakeRequestDto (global ValidationPipe contract)', () => {
  it('accepts the exact bot body with nullable fields emitted as null', async () => {
    await expectValid(validBody());
  });

  it('accepts omitted nullable fields (HD-02a normalizes them to null)', async () => {
    await expectValid(requiredOnlyBody());
  });

  it.each([
    'variantId',
    'sku',
    'requestedQuantity',
    'observedStockAtRequest',
    'stockObservedAt',
    'supersedesDecisionId',
  ])('accepts %s explicitly set to null', async (field) => {
    await expectValid(validBody({ [field]: null }));
  });

  it('accepts a fully populated body with real identifiers and values', async () => {
    await expectValid(
      validBody({
        variantId: VARIANT_ID,
        sku: 'SKU-1',
        requestedQuantity: 3,
        observedStockAtRequest: 0,
        stockObservedAt: '2026-02-01T10:00:00+02:00',
        supersedesDecisionId: SUPERSEDES_ID,
      }),
    );
  });

  it('rejects a missing type discriminant', async () => {
    const errors = await expectRejectedKey(omit(validBody(), ['type']), 'type');
    expect(errors).toHaveLength(1);
  });

  it.each(['RESTOCK_REQUEST', 'SHIPPING_APPROVAL', 'restock', '', 7])(
    'rejects the wrong type discriminant %p',
    async (type) => {
      await expectRejectedKey(validBody({ type }), 'type');
    },
  );

  it.each([
    'tenantId',
    'source',
    'branchId',
    'branchName',
    'credentialId',
    'submittedCredentialId',
    'credential',
    'customerId',
    'customerPhone',
    'phone',
    'transcript',
    'pii',
  ])('refuses the forbidden body authority/PII key %s', async (key) => {
    await expectRejectedKey(validBody({ [key]: 'not-from-body' }), key);
  });

  it.each([
    ['sourceRequestId', 'not-a-uuid'],
    ['sourceRequestId', '123'],
    ['productId', 'raw-secret-product-id'],
    ['variantId', 'abc'],
    ['supersedesDecisionId', 'xyz'],
  ])('rejects the malformed identifier %s=%p', async (field, value) => {
    await expectRejectedKey(validBody({ [field]: value }), field);
  });

  it.each([null, 123, true, {}, ['Filtro']])(
    'rejects a non-string productName %p',
    async (productName) => {
      await expectRejectedKey(validBody({ productName }), 'productName');
    },
  );

  it('rejects an empty productName', async () => {
    await expectRejectedKey(validBody({ productName: '' }), 'productName');
  });

  it.each([0, -1, 2.5, '3', Number.MAX_SAFE_INTEGER + 1])(
    'rejects requestedQuantity %p at the boundary',
    async (requestedQuantity) => {
      await expectRejectedKey(
        validBody({ requestedQuantity }),
        'requestedQuantity',
      );
    },
  );

  it.each([-1, 1.5, '0', Number.MAX_SAFE_INTEGER + 1])(
    'rejects observedStockAtRequest %p at the boundary',
    async (observedStockAtRequest) => {
      await expectRejectedKey(
        validBody({ observedStockAtRequest }),
        'observedStockAtRequest',
      );
    },
  );

  it('accepts the extreme safe-integer upper bounds', async () => {
    await expectValid(
      validBody({
        requestedQuantity: Number.MAX_SAFE_INTEGER,
        observedStockAtRequest: Number.MAX_SAFE_INTEGER,
      }),
    );
  });

  it.each([1, true, {}, ['2026-02-01T10:00:00Z']])(
    'rejects a non-string stockObservedAt %p (date TYPE)',
    async (stockObservedAt) => {
      await expectRejectedKey(
        validBody({ stockObservedAt }),
        'stockObservedAt',
      );
    },
  );

  it('does not echo raw submitted values in validation constraint messages', async () => {
    const errors = await expectRejectedKey(
      validBody({ productId: 'raw-secret-product-id' }),
      'productId',
    );
    const messages = errors.flatMap((error) =>
      Object.values(error.constraints ?? {}),
    );

    expect(messages.join(' ')).not.toContain('raw-secret-product-id');
    expect(messages).toContain('productId must be a UUID');
  });

  it('does not impose a raw productName length cap before normalization', async () => {
    await expectValid(validBody({ productName: 'a'.repeat(250) }));
  });

  it('does not impose a SKU length cap', async () => {
    await expectValid(validBody({ sku: 'S'.repeat(500) }));
  });
});

describe('RestockIntakeRequestDto <> HD-02a canonicalizer defense in depth', () => {
  it('normalizes accepted omitted nullable fields to null', async () => {
    await expectValid(requiredOnlyBody());

    const { request } = canonicalizeRestockRequest(canonicalInput());

    expect(request.variantId).toBeNull();
    expect(request.sku).toBeNull();
    expect(request.requestedQuantity).toBeNull();
    expect(request.observedStockAtRequest).toBeNull();
    expect(request.stockObservedAt).toBeNull();
    expect(request.supersedesDecisionId).toBeNull();
  });

  it('accepts a string timestamp the DTO cannot calendar-check, which HD-02a rejects', async () => {
    const body = validBody({ stockObservedAt: '2026-02-30T00:00:00Z' });
    await expectValid(body);

    expect(() =>
      canonicalizeRestockRequest(
        canonicalInput({ stockObservedAt: '2026-02-30T00:00:00Z' }),
      ),
    ).toThrow(InvalidArgumentError);
  });

  it('accepts a mismatched stock pair the DTO allows, which HD-02a rejects', async () => {
    const body = validBody({ observedStockAtRequest: 5 });
    await expectValid(body);

    expect(() =>
      canonicalizeRestockRequest(canonicalInput({ observedStockAtRequest: 5 })),
    ).toThrow(InvalidArgumentError);
  });

  it('rejects unsafe integers at the boundary AND keeps HD-02a as second line of defense', async () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 1;

    await expectRejectedKey(
      validBody({ requestedQuantity: unsafe }),
      'requestedQuantity',
    );

    expect(() =>
      canonicalizeRestockRequest(canonicalInput({ requestedQuantity: unsafe })),
    ).toThrow(InvalidArgumentError);
  });
});
