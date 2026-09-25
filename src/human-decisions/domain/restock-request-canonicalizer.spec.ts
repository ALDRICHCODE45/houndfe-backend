import { createHash } from 'node:crypto';
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import {
  canonicalizeRestockRequest,
  computeRestockRequestHash,
  normalizeRestockRequest,
  RESTOCK_PRODUCT_NAME_MAX_LENGTH,
  RESTOCK_SOURCE,
  RESTOCK_TYPE,
  type RestockRequestInput,
} from './restock-request-canonicalizer';

const TENANT_ID = 'tenant-1';
const SOURCE_REQUEST_ID = '3f1c1b7a-9c2e-4d5f-8a6b-1c2d3e4f5a6b';
const PRODUCT_ID = '8f14e45f-ceea-4e42-9f62-1a2b3c4d5e6f';
const OTHER_PRODUCT_ID = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
const VARIANT_ID = '550e8400-e29b-41d4-a716-446655440000';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const SUPERSEDES_ID = 'a1b2c3d4-e5f6-4789-8abc-def012345678';

function baseInput(
  overrides: Partial<RestockRequestInput> = {},
): RestockRequestInput {
  return {
    tenantId: TENANT_ID,
    sourceRequestId: SOURCE_REQUEST_ID,
    productId: PRODUCT_ID,
    productName: 'Filtro de aceite',
    submittedCredentialId: 'credential-1',
    ...overrides,
  };
}

function expectInvalid(overrides: Partial<RestockRequestInput>): void {
  expect(() => normalizeRestockRequest(baseInput(overrides))).toThrow(
    InvalidArgumentError,
  );
}

describe('restock-request-canonicalizer', () => {
  it('normalizes omitted nullable fields to null and fixes source and type', () => {
    const first = canonicalizeRestockRequest(baseInput());
    const second = canonicalizeRestockRequest(baseInput());

    expect(first.request).toEqual({
      tenantId: TENANT_ID,
      source: RESTOCK_SOURCE,
      type: RESTOCK_TYPE,
      sourceRequestId: SOURCE_REQUEST_ID,
      productId: PRODUCT_ID,
      productName: 'Filtro de aceite',
      variantId: null,
      sku: null,
      requestedQuantity: null,
      observedStockAtRequest: null,
      stockObservedAt: null,
      supersedesDecisionId: null,
      submittedCredentialId: 'credential-1',
    });
    // Deterministic: identical input always yields the same hash.
    expect(first.requestHash).toBe(second.requestHash);
    expect(first.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.request.source).toBe('houndfe-chatbot');
  });

  it('hashes the alphabetically sorted canonical allowlist as UTF-8 JSON', () => {
    const { request, requestHash } = canonicalizeRestockRequest(
      baseInput({
        productName: '  Filtro   de aceite ',
        variantId: VARIANT_ID,
        sku: 'SKU-1',
        requestedQuantity: 3,
        observedStockAtRequest: 0,
        stockObservedAt: '2026-02-01T10:00:00+02:00',
        supersedesDecisionId: SUPERSEDES_ID,
      }),
    );

    const canonical = {
      normalizedProductName: 'Filtro de aceite',
      observedStockAtRequest: 0,
      productId: PRODUCT_ID,
      requestedQuantity: 3,
      sku: 'SKU-1',
      source: RESTOCK_SOURCE,
      sourceRequestId: SOURCE_REQUEST_ID,
      stockObservedAt: '2026-02-01T08:00:00.000Z',
      supersedesDecisionId: SUPERSEDES_ID,
      tenantId: TENANT_ID,
      type: RESTOCK_TYPE,
      variantId: VARIANT_ID,
    };

    expect(request.stockObservedAt).toBe('2026-02-01T08:00:00.000Z');
    expect(requestHash).toBe(
      createHash('sha256')
        .update(JSON.stringify(canonical), 'utf8')
        .digest('hex'),
    );
  });

  it('reuses the hash for a semantically identical replay regardless of key order', () => {
    const first = canonicalizeRestockRequest(
      baseInput({
        requestedQuantity: 2,
        observedStockAtRequest: 5,
        stockObservedAt: '2026-02-01T00:00:00Z',
      }),
    );
    const replay = canonicalizeRestockRequest({
      submittedCredentialId: 'credential-1',
      stockObservedAt: '2026-02-01T00:00:00Z',
      observedStockAtRequest: 5,
      requestedQuantity: 2,
      productName: 'Filtro de aceite',
      productId: PRODUCT_ID,
      sourceRequestId: SOURCE_REQUEST_ID,
      tenantId: TENANT_ID,
    });

    expect(replay.requestHash).toBe(first.requestHash);
  });

  it('treats timezone-equivalent instants as the same canonical UTC value', () => {
    const utc = canonicalizeRestockRequest(
      baseInput({
        observedStockAtRequest: 1,
        stockObservedAt: '2026-02-01T08:00:00Z',
      }),
    );
    const offset = canonicalizeRestockRequest(
      baseInput({
        observedStockAtRequest: 1,
        stockObservedAt: '2026-02-01T10:00:00+02:00',
      }),
    );

    expect(offset.request.stockObservedAt).toBe(utc.request.stockObservedAt);
    expect(offset.requestHash).toBe(utc.requestHash);
  });

  it('changes the hash when product, stock or supersedes identity changes', () => {
    const stock: Partial<RestockRequestInput> = {
      observedStockAtRequest: 1,
      stockObservedAt: '2026-02-01T00:00:00Z',
    };
    const base = canonicalizeRestockRequest(baseInput(stock)).requestHash;
    const changed: Partial<RestockRequestInput>[] = [
      { productId: OTHER_PRODUCT_ID },
      { observedStockAtRequest: 2 },
      { supersedesDecisionId: SUPERSEDES_ID },
    ];

    for (const override of changed) {
      expect(
        canonicalizeRestockRequest(baseInput({ ...stock, ...override }))
          .requestHash,
      ).not.toBe(base);
    }
  });

  it('excludes the audit-only credential and arbitrary keys from the hash', () => {
    const first = canonicalizeRestockRequest(
      baseInput({
        submittedCredentialId: 'credential-1',
        requestedQuantity: 1,
      }),
    );
    const rotated = canonicalizeRestockRequest(
      baseInput({
        submittedCredentialId: 'credential-2',
        requestedQuantity: 1,
      }),
    );

    expect(rotated.request.submittedCredentialId).toBe('credential-2');
    expect(rotated.requestHash).toBe(first.requestHash);

    const withExtras = canonicalizeRestockRequest({
      ...baseInput({ requestedQuantity: 1 }),
      branchName: 'sucursal',
      creationTime: '2026-02-01T00:00:00Z',
    } as RestockRequestInput);
    expect(withExtras.requestHash).toBe(first.requestHash);
  });

  it('accepts exactly the 200-UTF-16 bound and rejects 201 without splitting surrogates', () => {
    const atLimit = 'a'.repeat(RESTOCK_PRODUCT_NAME_MAX_LENGTH);
    expect(
      normalizeRestockRequest(baseInput({ productName: atLimit })).productName,
    ).toBe(atLimit);

    expect(() =>
      normalizeRestockRequest(
        baseInput({
          productName: 'a'.repeat(RESTOCK_PRODUCT_NAME_MAX_LENGTH + 1),
        }),
      ),
    ).toThrow(InvalidArgumentError);

    const emoji = '\u{1F600}'; // 2 UTF-16 code units each.
    const withinBound = emoji.repeat(100);
    expect(
      normalizeRestockRequest(baseInput({ productName: withinBound }))
        .productName,
    ).toBe(withinBound);
    expect(() =>
      normalizeRestockRequest(baseInput({ productName: emoji.repeat(101) })),
    ).toThrow(InvalidArgumentError);
  });

  it('normalizes product names with NFC and collapsed whitespace', () => {
    expect(
      normalizeRestockRequest(
        baseInput({ productName: '  Cafe\u0301   de   filtro  ' }),
      ).productName,
    ).toBe('Caf\u00e9 de filtro');
    expect(
      normalizeRestockRequest(baseInput({ productName: 'A\u00a0\u00a0B' }))
        .productName,
    ).toBe('A B');
  });

  const invalidProductNames: Partial<RestockRequestInput>[] = [
    { productName: '' },
    { productName: '   ' },
    { productName: 'bad\u0000name' },
    { productName: 'bad\tname' },
  ];

  it.each(invalidProductNames)('rejects product name %#', expectInvalid);

  const invalidQuantities: Partial<RestockRequestInput>[] = [
    { requestedQuantity: 0 },
    { requestedQuantity: -1 },
    { requestedQuantity: 1.5 },
    { requestedQuantity: Number.MAX_SAFE_INTEGER + 1 },
    { observedStockAtRequest: -1, stockObservedAt: '2026-02-01T00:00:00Z' },
  ];

  it.each(invalidQuantities)('rejects quantity/stock %#', expectInvalid);

  it('accepts a zero observed stock', () => {
    const zeroStock = normalizeRestockRequest(
      baseInput({
        observedStockAtRequest: 0,
        stockObservedAt: '2026-02-01T00:00:00Z',
      }),
    );

    expect(zeroStock.observedStockAtRequest).toBe(0);
  });

  const unpairedStock: Partial<RestockRequestInput>[] = [
    { observedStockAtRequest: 5 },
    { stockObservedAt: '2026-02-01T00:00:00Z' },
  ];

  it.each(unpairedStock)('requires paired stock %#', expectInvalid);

  it('requires a canonical UUID productId and rejects fake or blank values', () => {
    expectInvalid({ productId: 'product-1' });
    expectInvalid({ productId: '' });
    expectInvalid({ productId: '   ' });
    expectInvalid({ productId: NIL_UUID });

    expect(
      normalizeRestockRequest(
        baseInput({ productId: PRODUCT_ID.toUpperCase() }),
      ).productId,
    ).toBe(PRODUCT_ID);
  });

  it('requires a UUID variantId when present and rejects a blank present value', () => {
    expectInvalid({ variantId: 'variant-1' });
    expectInvalid({ variantId: '' });
    expectInvalid({ variantId: '   ' });
    expectInvalid({ variantId: NIL_UUID });

    expect(
      normalizeRestockRequest(
        baseInput({ variantId: VARIANT_ID.toUpperCase() }),
      ).variantId,
    ).toBe(VARIANT_ID);
    expect(
      normalizeRestockRequest(baseInput({ variantId: null })).variantId,
    ).toBeNull();
    expect(
      normalizeRestockRequest(baseInput({ variantId: undefined })).variantId,
    ).toBeNull();
  });

  it('normalizes sku with NFC and trim, rejects controls and keeps long values', () => {
    expect(normalizeRestockRequest(baseInput({ sku: '  SKU-  1  ' })).sku).toBe(
      'SKU-  1',
    );
    expect(normalizeRestockRequest(baseInput({ sku: 'sku\u0301' })).sku).toBe(
      'sk\u00fa',
    );
    expect(normalizeRestockRequest(baseInput({ sku: '   ' })).sku).toBeNull();

    const longSku = 's'.repeat(5000);
    expect(normalizeRestockRequest(baseInput({ sku: longSku })).sku).toBe(
      longSku,
    );

    expectInvalid({ sku: 'bad\u0000sku' });
    expectInvalid({ sku: 'bad\tsku' });
    expectInvalid({ sku: 'bad\u0085sku' });
  });

  const invalidDates: Partial<RestockRequestInput>[] = [
    { observedStockAtRequest: 1, stockObservedAt: 'not-a-date' },
    { observedStockAtRequest: 1, stockObservedAt: '' },
    // Date.parse rollover must not be accepted.
    { observedStockAtRequest: 1, stockObservedAt: '2026-02-30T00:00:00Z' },
    // Locale form, not ISO.
    { observedStockAtRequest: 1, stockObservedAt: '02/01/2026' },
    // Missing time or explicit zone.
    { observedStockAtRequest: 1, stockObservedAt: '2026-02-01' },
    { observedStockAtRequest: 1, stockObservedAt: '2026-02-01T00:00:00' },
    // Out-of-range calendar/time components.
    { observedStockAtRequest: 1, stockObservedAt: '2026-13-01T00:00:00Z' },
    { observedStockAtRequest: 1, stockObservedAt: '2026-02-01T24:00:00Z' },
    { observedStockAtRequest: 1, stockObservedAt: '2026-02-01T00:60:00Z' },
    { observedStockAtRequest: 1, stockObservedAt: '2026-02-01T00:00:60Z' },
    // Non-leap Feb 29, including the 1900 century exception.
    { observedStockAtRequest: 1, stockObservedAt: '2026-02-29T12:00:00Z' },
    { observedStockAtRequest: 1, stockObservedAt: '1900-02-29T12:00:00Z' },
    // Illegal timezone offsets.
    { observedStockAtRequest: 1, stockObservedAt: '2026-02-01T00:00:00+25:00' },
    { observedStockAtRequest: 1, stockObservedAt: '2026-02-01T00:00:00+02:60' },
  ];

  it.each(invalidDates)('rejects invalid stockObservedAt %#', expectInvalid);

  it('accepts Gregorian leap days and preserves milliseconds', () => {
    expect(
      normalizeRestockRequest(
        baseInput({
          observedStockAtRequest: 1,
          stockObservedAt: '2024-02-29T12:00:00Z',
        }),
      ).stockObservedAt,
    ).toBe('2024-02-29T12:00:00.000Z');
    expect(
      normalizeRestockRequest(
        baseInput({
          observedStockAtRequest: 1,
          stockObservedAt: '2000-02-29T12:00:00Z',
        }),
      ).stockObservedAt,
    ).toBe('2000-02-29T12:00:00.000Z');
    expect(
      normalizeRestockRequest(
        baseInput({
          observedStockAtRequest: 1,
          stockObservedAt: '2026-02-01T08:00:00.250Z',
        }),
      ).stockObservedAt,
    ).toBe('2026-02-01T08:00:00.250Z');
  });

  it('normalizes valid timezone forms to the same UTC instant', () => {
    const forms = [
      '2026-02-01T08:00:00Z',
      '2026-02-01T08:00:00.000Z',
      '2026-02-01T08:00:00+00:00',
      '2026-02-01T08:00:00-00:00',
      '2026-02-01T10:00:00+02:00',
      '2026-02-01T06:00:00-02:00',
    ];
    const hashes = forms.map(
      (stockObservedAt) =>
        canonicalizeRestockRequest(
          baseInput({ observedStockAtRequest: 1, stockObservedAt }),
        ).requestHash,
    );

    expect(new Set(hashes).size).toBe(1);
    expect(
      normalizeRestockRequest(
        baseInput({
          observedStockAtRequest: 1,
          stockObservedAt: '2026-02-01T10:00:00+02:00',
        }),
      ).stockObservedAt,
    ).toBe('2026-02-01T08:00:00.000Z');
  });

  const invalidTrusted: Partial<RestockRequestInput>[] = [
    { tenantId: '' },
    { tenantId: '   ' },
    { submittedCredentialId: '' },
    { submittedCredentialId: '   ' },
  ];

  it.each(invalidTrusted)('rejects blank trusted input %#', expectInvalid);

  it('validates UUIDs, normalizes case and rejects the nil UUID', () => {
    expect(() =>
      normalizeRestockRequest(baseInput({ sourceRequestId: 'not-a-uuid' })),
    ).toThrow(InvalidArgumentError);
    expect(() =>
      normalizeRestockRequest(baseInput({ supersedesDecisionId: 'nope' })),
    ).toThrow(InvalidArgumentError);
    expect(() =>
      normalizeRestockRequest(baseInput({ sourceRequestId: NIL_UUID })),
    ).toThrow(InvalidArgumentError);

    expect(
      normalizeRestockRequest(
        baseInput({ sourceRequestId: SOURCE_REQUEST_ID.toUpperCase() }),
      ).sourceRequestId,
    ).toBe(SOURCE_REQUEST_ID);
  });

  it('does not include raw input values in validation errors', () => {
    const secret = 'do-not-leak-123';

    try {
      normalizeRestockRequest(baseInput({ productName: `bad\n${secret}` }));
      throw new Error('expected validation error');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidArgumentError);
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it('computes the same hash from an already normalized request', () => {
    const { request, requestHash } = canonicalizeRestockRequest(baseInput());

    expect(computeRestockRequestHash(request)).toBe(requestHash);
  });
});
