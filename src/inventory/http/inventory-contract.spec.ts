import {
  hashAdjustmentBody,
  inventoryErrorEnvelope,
  InventoryContractError,
  parseAdjustmentBody,
  parseInventoryId,
  parseInventoryIdempotencyKey,
  parseMovementsQuery,
} from './inventory-contract';

const P = '10000000-0000-4000-8000-000000000001';
const V = '10000000-0000-4000-8000-000000000002';
const L = '10000000-0000-4000-8000-000000000003';
const valid = {
  target: { productId: P },
  expectedVersion: 0,
  delta: -3,
  reason: 'DAMAGE',
};
const malformed = (work: () => unknown) =>
  expect(work).toThrow(new InventoryContractError('MALFORMED'));

describe('inventory adjustment body (S3, S4)', () => {
  it('parses an untracked, variant and lot target into one normalized shape', () => {
    expect(parseAdjustmentBody(valid)).toEqual({
      target: { productId: P, variantId: null, lotId: null },
      expectedVersion: 0,
      delta: -3,
      reason: 'DAMAGE',
      note: null,
    });
    expect(
      parseAdjustmentBody({
        ...valid,
        target: { productId: P.toUpperCase(), variantId: V },
        note: '  recount  ',
      }).target,
    ).toEqual({ productId: P, variantId: V, lotId: null });
    expect(
      parseAdjustmentBody({ ...valid, target: { productId: P, lotId: L } })
        .target,
    ).toEqual({ productId: P, variantId: null, lotId: L });
    expect(parseAdjustmentBody({ ...valid, note: '  recount  ' }).note).toBe(
      'recount',
    );
  });

  it.each([
    'PHYSICAL_COUNT',
    'DAMAGE',
    'EXPIRED',
    'THEFT_LOSS',
    'DATA_ENTRY_CORRECTION',
  ])('accepts %s without a note', (reason) => {
    expect(parseAdjustmentBody({ ...valid, reason }).reason).toBe(reason);
    expect(
      parseAdjustmentBody({ ...valid, reason, note: '   ' }).note,
    ).toBeNull();
  });

  it('requires a non-blank note of at most 500 characters for OTHER', () => {
    const other = { ...valid, reason: 'OTHER' };
    malformed(() => parseAdjustmentBody(other));
    malformed(() => parseAdjustmentBody({ ...other, note: null }));
    malformed(() => parseAdjustmentBody({ ...other, note: '  \n ' }));
    malformed(() => parseAdjustmentBody({ ...other, note: 'x'.repeat(501) }));
    expect(
      parseAdjustmentBody({ ...other, note: 'x'.repeat(500) }).note,
    ).toHaveLength(500);
    malformed(() => parseAdjustmentBody({ ...valid, note: 'x'.repeat(501) }));
  });

  it('rejects delta 0, fractions, non-numbers and out-of-range values', () => {
    for (const delta of [
      0,
      1.5,
      '3',
      null,
      NaN,
      Infinity,
      1_000_000_001,
      -1_000_000_001,
    ])
      malformed(() => parseAdjustmentBody({ ...valid, delta }));
    expect(parseAdjustmentBody({ ...valid, delta: 1_000_000_000 }).delta).toBe(
      1_000_000_000,
    );
  });

  it('requires a non-negative integer expectedVersion (versions start at 0)', () => {
    for (const expectedVersion of [-1, 1.2, '0', null, undefined, 2 ** 53])
      malformed(() => parseAdjustmentBody({ ...valid, expectedVersion }));
  });

  it('rejects unknown reasons, unknown or missing keys and both variant and lot', () => {
    malformed(() => parseAdjustmentBody({ ...valid, reason: 'FOUND' }));
    malformed(() => parseAdjustmentBody({ ...valid, extra: 1 }));
    malformed(() => parseAdjustmentBody({ ...valid, tenantId: 't' }));
    malformed(() => parseAdjustmentBody({ target: valid.target }));
    malformed(() => parseAdjustmentBody({ ...valid, target: {} }));
    malformed(() =>
      parseAdjustmentBody({ ...valid, target: { productId: 'x' } }),
    );
    malformed(() =>
      parseAdjustmentBody({
        ...valid,
        target: { productId: P, variantId: V, lotId: L },
      }),
    );
    malformed(() =>
      parseAdjustmentBody({ ...valid, target: { productId: P, quantity: 1 } }),
    );
    for (const body of [null, [], 'x', 7])
      malformed(() => parseAdjustmentBody(body));
  });

  it('hashes the normalized body so equivalent spellings replay', () => {
    expect(hashAdjustmentBody({ ...valid, note: null })).toBe(
      hashAdjustmentBody({ ...valid, target: { productId: P.toUpperCase() } }),
    );
    expect(hashAdjustmentBody(valid)).not.toBe(
      hashAdjustmentBody({ ...valid, delta: -4 }),
    );
    expect(hashAdjustmentBody(valid)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('inventory movements query (S10)', () => {
  it('requires productId and defaults limit to 25', () => {
    expect(parseMovementsQuery({ productId: P })).toEqual({
      productId: P,
      limit: 25,
    });
    malformed(() => parseMovementsQuery({}));
  });

  it('parses filters, cursor and limit up to 100', () => {
    expect(
      parseMovementsQuery({
        productId: P,
        variantId: V,
        limit: '100',
        cursor: 'c',
      }),
    ).toEqual({ productId: P, variantId: V, limit: 100, cursor: 'c' });
    expect(parseMovementsQuery({ productId: P, lotId: L }).lotId).toBe(L);
  });

  it.each(['0', '101', '-1', '1.5', 'x', '', '025', ['1', '2']])(
    'rejects limit %p',
    (limit) => malformed(() => parseMovementsQuery({ productId: P, limit })),
  );

  it('rejects unknown params, repeated ids, empty cursor and variant plus lot', () => {
    malformed(() => parseMovementsQuery({ productId: P, tenantId: 't' }));
    malformed(() => parseMovementsQuery({ productId: [P, P] }));
    malformed(() => parseMovementsQuery({ productId: P, cursor: '' }));
    malformed(() =>
      parseMovementsQuery({ productId: P, variantId: V, lotId: L }),
    );
    malformed(() => parseMovementsQuery({ productId: 'nope' }));
  });
});

describe('inventory ids, keys and envelope', () => {
  it('normalizes ids and takes exactly one Idempotency-Key header', () => {
    expect(parseInventoryId(P.toUpperCase())).toBe(P);
    malformed(() => parseInventoryId('1'));
    expect(parseInventoryIdempotencyKey(['Idempotency-Key', 'k1'])).toBe('k1');
    malformed(() => parseInventoryIdempotencyKey([]));
    malformed(() =>
      parseInventoryIdempotencyKey([
        'Idempotency-Key',
        'a',
        'idempotency-key',
        'b',
      ]),
    );
  });

  it('maps every documented code to its status and hides anything else', () => {
    const table: Record<string, number> = {
      MALFORMED: 400,
      UNAUTHORIZED: 401,
      FORBIDDEN: 403,
      NOT_FOUND: 404,
      STOCK_VERSION_CONFLICT: 409,
      INSUFFICIENT_STOCK: 409,
      STOCK_NOT_TRACKED: 409,
      IDEMPOTENCY_KEY_CONFLICT: 409,
      IDEMPOTENCY_KEY_IN_FLIGHT: 409,
      INTERNAL_ERROR: 500,
    };
    for (const [code, statusCode] of Object.entries(table))
      expect(
        inventoryErrorEnvelope(new InventoryContractError(code as 'MALFORMED')),
      ).toEqual({ statusCode, error: code });
    expect(inventoryErrorEnvelope(new Error('secret'))).toEqual({
      statusCode: 500,
      error: 'INTERNAL_ERROR',
    });
  });
});
