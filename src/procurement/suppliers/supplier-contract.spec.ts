import {
  hashSupplierBody,
  parseSupplierInput,
  parseSupplierUpdate,
  parseSupplierListQuery,
  parseSupplierId,
  parseSupplierIdempotencyKey,
  SupplierContractError,
  supplierErrorEnvelope,
} from './supplier-contract';

const input = { displayName: ' Supplier ', termsText: null, status: 'ACTIVE' };
const update = { expectedVersion: 1, changes: { termsText: null } };
const malformed = (run: () => unknown) => {
  expect(run).toThrow(SupplierContractError);
  try {
    run();
  } catch (error) {
    expect(supplierErrorEnvelope(error)).toEqual({
      statusCode: 400,
      error: 'MALFORMED',
    });
  }
};

describe('supplier closed bodies', () => {
  test('preserves name and terms verbatim and returns detached data', () => {
    const body = { ...input, termsText: ' \nTerms\t ', status: 'ARCHIVED' };
    expect(parseSupplierInput(body)).toEqual(body);
    expect(parseSupplierInput(body)).not.toBe(body);
  });
  test.each(['displayName', 'termsText', 'status'])('requires %s', (key) => {
    const body = { ...input };
    delete body[key];
    malformed(() => parseSupplierInput(body));
  });
  test.each([
    null,
    [],
    1,
    'body',
    { ...input, tenantId: 'foreign' },
    { ...input, status: 'ALL' },
    { ...input, termsText: undefined },
    { ...input, displayName: 1 },
  ])('rejects malformed input %#', (body) =>
    malformed(() => parseSupplierInput(body)),
  );
  test.each(['', ' \n\t\u00a0', 'a'.repeat(201), '\ud800', '\udfff', 'a\0b'])(
    'rejects invalid name %#',
    (displayName) =>
      malformed(() => parseSupplierInput({ ...input, displayName })),
  );
  test('counts name Unicode codepoints, not UTF-16 units', () => {
    expect(
      parseSupplierInput({ ...input, displayName: '😀'.repeat(200) })
        .displayName,
    ).toBe('😀'.repeat(200));
    malformed(() =>
      parseSupplierInput({ ...input, displayName: '😀'.repeat(201) }),
    );
  });
  test('accepts empty terms and 4000 Unicode codepoints', () => {
    for (const termsText of ['', '😀'.repeat(4000)])
      expect(parseSupplierInput({ ...input, termsText }).termsText).toBe(
        termsText,
      );
  });
  test.each(['a'.repeat(4001), '\ud800', '\udfff', '\0'])(
    'rejects invalid terms %#',
    (termsText) => malformed(() => parseSupplierInput({ ...input, termsText })),
  );
  test('patch omission preserves, null clears; archive/reactivate are explicit', () => {
    for (const changes of [
      { displayName: 'New' },
      { termsText: null },
      { status: 'ARCHIVED' },
      { status: 'ACTIVE' },
      input,
    ]) {
      expect(
        parseSupplierUpdate({
          expectedVersion: Number.MAX_SAFE_INTEGER,
          changes,
        }),
      ).toEqual({ expectedVersion: Number.MAX_SAFE_INTEGER, changes });
    }
  });
  test.each([
    0,
    -1,
    1.1,
    '1',
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    null,
  ])('rejects invalid CAS %#', (expectedVersion) =>
    malformed(() => parseSupplierUpdate({ ...update, expectedVersion })),
  );
  test.each([
    {},
    { changes: {} },
    { expectedVersion: 1 },
    { ...update, extra: true },
    { ...update, changes: {} },
    { ...update, changes: { termsText: undefined } },
    { ...update, changes: { displayName: null } },
    { ...update, changes: { status: 'ALL' } },
    { ...update, changes: { extra: 1 } },
  ])('rejects malformed update %#', (body) =>
    malformed(() => parseSupplierUpdate(body)),
  );
  test('rejects symbols, hidden fields, accessors and custom prototypes without invoking getters', () => {
    const getter = jest.fn(() => 'Supplier');
    for (const body of [
      Object.assign({ ...input }, { [Symbol('extra')]: 1 }),
      Object.defineProperty({ ...input }, 'extra', { value: 1 }),
      Object.defineProperty({ ...input }, 'displayName', {
        get: getter,
        enumerable: true,
      }),
      Object.assign(Object.create({ inherited: true }), input),
    ])
      malformed(() => parseSupplierInput(body));
    expect(getter).not.toHaveBeenCalled();
    malformed(() =>
      parseSupplierInput(
        new Proxy(
          {},
          {
            ownKeys() {
              throw new Error('private');
            },
          },
        ),
      ),
    );
  });
});

describe('supplier list and identity', () => {
  test.each(['ACTIVE', 'ARCHIVED', 'ALL'])(
    'requires explicit status %s and defaults limit',
    (status) =>
      expect(parseSupplierListQuery({ status })).toEqual({ status, limit: 25 }),
  );
  test('trims only search edges, blank means no filter; cursor stays opaque', () => {
    expect(
      parseSupplierListQuery({
        status: 'ALL',
        search: '  A  b%_\\  ',
        cursor: 'opaque+/=',
        limit: '100',
      }),
    ).toEqual({
      status: 'ALL',
      search: 'A  b%_\\',
      cursor: 'opaque+/=',
      limit: 100,
    });
    expect(parseSupplierListQuery({ status: 'ALL', search: ' \t ' })).toEqual({
      status: 'ALL',
      limit: 25,
    });
    expect(
      parseSupplierListQuery({
        status: 'ALL',
        limit: '1',
        search: '😀'.repeat(200),
      }).limit,
    ).toBe(1);
  });
  test.each([
    '0',
    '101',
    '01',
    '+1',
    '-1',
    '1.0',
    '1e1',
    '0x10',
    ' 1',
    '1 ',
    '',
    'Infinity',
    '9007199254740992',
    25,
    null,
    ['25', '25'],
  ])('rejects nondecimal/out-of-range/repeated limit %#', (limit) =>
    malformed(() => parseSupplierListQuery({ status: 'ALL', limit })),
  );
  test.each([
    {},
    { status: 'active' },
    { status: ['ALL', 'ALL'] },
    { status: 'ALL', extra: 'x' },
    { status: 'ALL', search: ['a'] },
    { status: 'ALL', search: null },
    { status: 'ALL', search: '😀'.repeat(201) },
    { status: 'ALL', search: '\0' },
    { status: 'ALL', search: '\ud800' },
    { status: 'ALL', cursor: ['x'] },
    { status: 'ALL', cursor: '' },
    { status: 'ALL', cursor: null },
  ])('rejects invalid query %#', (query) =>
    malformed(() => parseSupplierListQuery(query)),
  );
  test('UUID follows existing trim/lowercase v1-v8 and variant policy', () => {
    expect(parseSupplierId(' 550E8400-E29B-41D4-A716-446655440000 ')).toBe(
      '550e8400-e29b-41d4-a716-446655440000',
    );
    for (const id of [
      null,
      [],
      '00000000-0000-0000-0000-000000000000',
      '550e8400-e29b-91d4-a716-446655440000',
      '550e8400-e29b-41d4-7716-446655440000',
      'bad',
    ])
      malformed(() => parseSupplierId(id));
  });
});

describe('supplier idempotency and errors', () => {
  test.each(['x', 'x'.repeat(200), '  ', ' key ', 'key,other', '\tkey', 'é'])(
    'preserves legal HTTP key %# without UUID restrictions',
    (key) =>
      expect(
        parseSupplierIdempotencyKey(['X-Other', 'ok', 'iDeMpOtEnCy-KeY', key]),
      ).toBe(key),
  );
  test.each(
    [
      [],
      ['Idempotency-Key', ''],
      ['Idempotency-Key', 'x'.repeat(201)],
      ['Idempotency-Key', 'a', 'IDEMPOTENCY-KEY', 'b'],
      ['Idempotency-Key'],
      ['Idempotency-Key', '\n'],
      ['Idempotency-Key', '\0'],
      ['Idempotency-Key', '\u007f'],
      ['Idempotency-Key', '😀'],
      ['Idempotency-Key', 1],
    ].map((headers) => [headers]),
  )('rejects absent/duplicate/malformed header %#', (headers) =>
    malformed(() => parseSupplierIdempotencyKey(headers)),
  );
  test('hash ignores object key order including patch order', () => {
    expect(hashSupplierBody('create', input)).toBe(
      hashSupplierBody('create', {
        status: 'ACTIVE',
        termsText: null,
        displayName: ' Supplier ',
      }),
    );
    expect(
      hashSupplierBody('update', {
        expectedVersion: 1,
        changes: { status: 'ACTIVE', termsText: null },
      }),
    ).toBe(
      hashSupplierBody('update', {
        changes: { termsText: null, status: 'ACTIVE' },
        expectedVersion: 1,
      }),
    );
    expect(hashSupplierBody('create', input)).toMatch(/^[0-9a-f]{64}$/);
  });
  test('hash preserves content, null versus omission, and CAS', () => {
    const bodies = [
      update,
      { ...update, expectedVersion: 2 },
      { expectedVersion: 1, changes: { status: 'ACTIVE' } },
      { expectedVersion: 1, changes: { status: 'ACTIVE', termsText: null } },
      { expectedVersion: 1, changes: { termsText: '' } },
    ];
    expect(
      new Set(bodies.map((body) => hashSupplierBody('update', body))).size,
    ).toBe(bodies.length);
    expect(hashSupplierBody('create', input)).not.toBe(
      hashSupplierBody('create', { ...input, displayName: 'Supplier' }),
    );
    expect(hashSupplierBody('create', { ...input, displayName: 'é' })).not.toBe(
      hashSupplierBody('create', { ...input, displayName: 'e\u0301' }),
    );
    malformed(() => hashSupplierBody('create', { ...input, ignored: true }));
  });
  test.each([
    ['MALFORMED', 400],
    ['UNAUTHORIZED', 401],
    ['FORBIDDEN', 403],
    ['NOT_FOUND', 404],
    ['SUPPLIER_VERSION_CONFLICT', 409],
    ['IDEMPOTENCY_KEY_CONFLICT', 409],
    ['IDEMPOTENCY_KEY_IN_FLIGHT', 409],
    ['INTERNAL_ERROR', 500],
  ] as const)('maps only supplier error %s', (code, statusCode) =>
    expect(supplierErrorEnvelope(new SupplierContractError(code))).toEqual({
      statusCode,
      error: code,
    }),
  );
  test('unexpected errors cannot leak details', () =>
    expect(supplierErrorEnvelope(new Error('private'))).toEqual({
      statusCode: 500,
      error: 'INTERNAL_ERROR',
    }));
});
