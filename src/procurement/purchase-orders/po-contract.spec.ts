import {
  hashPurchaseOrderBody,
  parseOrderInput,
  parsePurchaseOrderReplace,
  parsePurchaseOrderDelete,
  parsePurchaseOrderListQuery,
  parsePurchaseOrderId,
  parsePurchaseOrderIdempotencyKey,
  PurchaseOrderContractError,
  purchaseOrderErrorEnvelope,
  UNITS_OF_MEASURE,
} from './po-contract';

const id = '10000000-0000-4000-8000-000000000001';
const line = () => ({
  lineId: id,
  productId: null,
  variantId: null,
  orderedQuantity: null,
  informedUnitCost: null,
});
const order = () => ({
  supplierId: null,
  note: null,
  location: { detail: null },
  lines: [line()],
});
const bad = (value: unknown) => {
  expect(() => parseOrderInput(value)).toThrow('MALFORMED');
};

describe('purchase-order closed admission', () => {
  it('accepts incomplete detached drafts, preserving text and codepoints', () => {
    const body = {
      ...order(),
      note: ' 😀 '.repeat(500),
      location: { detail: '😀'.repeat(500) },
    };
    expect(parseOrderInput(body)).toEqual(body);
    expect(parseOrderInput(body).lines[0]).not.toBe(body.lines[0]);
    expect(parseOrderInput({ ...order(), lines: [] }).lines).toEqual([]);
    expect(
      parseOrderInput({ ...order(), note: '😀'.repeat(2000) }).note,
    ).toHaveLength(4000);
  });
  it.each(['supplierId', 'note', 'location', 'lines'])('requires %s', (key) => {
    const body: Record<string, unknown> = order();
    delete body[key];
    bad(body);
  });
  it.each([
    null,
    [],
    {},
    { ...order(), extra: true },
    { ...order(), location: {} },
    { ...order(), location: { detail: null, extra: true } },
    { ...order(), lines: Array<unknown>(201).fill(line()) },
    ...['\0', '\ud800', '\udfff', '😀'.repeat(2001)].map((note) => ({
      ...order(),
      note,
    })),
    { ...order(), location: { detail: '😀'.repeat(501) } },
  ])('rejects invalid order %#', bad);
  it('rejects hidden, symbol, getter, prototype and hostile proxy fields', () => {
    const getter = jest.fn();
    for (const body of [
      Object.assign(order(), { [Symbol('x')]: true }),
      Object.defineProperty(order(), 'hidden', { value: true }),
      Object.defineProperty(order(), 'note', { get: getter, enumerable: true }),
      Object.assign(Object.create({ inherited: true }) as object, order()),
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error('private');
          },
        },
      ),
    ])
      bad(body);
    expect(getter).not.toHaveBeenCalled();
  });
  it('requires all nested fields; rejects sparse lines and array getters', () => {
    for (const key of Object.keys(line())) {
      const item: Record<string, unknown> = line();
      delete item[key];
      bad({ ...order(), lines: [item] });
    }
    bad({ ...order(), lines: new Array<unknown>(1) });
    bad({ ...order(), lines: [{ ...line(), extra: true }] });
    for (const cost of [
      {},
      { amount: null, currency: null, unit: null },
      { amount: null, currency: null, unit: null, taxBasis: null, extra: true },
    ])
      bad({ ...order(), lines: [{ ...line(), informedUnitCost: cost }] });
    const getter = jest.fn();
    const lines = Object.defineProperty([line()], '0', {
      get: getter,
      enumerable: true,
    });
    bad({ ...order(), lines });
    expect(getter).not.toHaveBeenCalled();
  });
  it('accepts exactly 200 distinct lines', () => {
    const lines = Array.from({ length: 200 }, (_, index) => ({
      ...line(),
      lineId: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    }));
    expect(parseOrderInput({ ...order(), lines }).lines).toHaveLength(200);
  });
  it('normalizes UUIDs and detects duplicate normalized line ids', () => {
    expect(parsePurchaseOrderId(` ${id.toUpperCase()} `)).toBe(id);
    expect(
      parseOrderInput({ ...order(), supplierId: ` ${id} ` }).supplierId,
    ).toBe(id);
    bad({ ...order(), lines: [line(), { ...line(), lineId: ` ${id} ` }] });
    bad({ ...order(), lines: [{ ...line(), variantId: id }] });
    bad({ ...order(), supplierId: 'invalid' });
  });
  it.each([
    '0',
    '0.000',
    '-1',
    '01',
    '.1',
    '1.',
    '1e1',
    '1.0000',
    '1000000000',
    ' 1',
    '1\n',
    '1\u2028',
    1,
  ])('rejects quantity %#', (orderedQuantity) => {
    bad({ ...order(), lines: [{ ...line(), orderedQuantity }] });
  });
  it.each(['0.001', '1', '999999999.999', '1.000'])(
    'accepts quantity %s',
    (orderedQuantity) => {
      expect(
        parseOrderInput({
          ...order(),
          lines: [{ ...line(), orderedQuantity }],
        }).lines[0].orderedQuantity,
      ).toBe(orderedQuantity);
    },
  );
  it('admits all 14 units and nullable cost parts, MXN only', () => {
    expect(UNITS_OF_MEASURE).toHaveLength(14);
    for (const unit of UNITS_OF_MEASURE) {
      const informedUnitCost = {
        amount: '999999999999.9999',
        currency: 'MXN',
        unit,
        taxBasis: 'EXCLUDES_TAX',
      };
      expect(
        parseOrderInput({
          ...order(),
          lines: [{ ...line(), informedUnitCost }],
        }).lines[0].informedUnitCost,
      ).toEqual(informedUnitCost);
    }
    for (const amount of ['0', '0.0000', null])
      expect(
        parseOrderInput({
          ...order(),
          lines: [
            {
              ...line(),
              informedUnitCost: {
                amount,
                currency: null,
                unit: null,
                taxBasis: null,
              },
            },
          ],
        }).lines,
      ).toHaveLength(1);
    for (const change of [
      { amount: '-1' },
      { amount: '01' },
      { amount: '1000000000000' },
      { amount: '1.00000' },
      { amount: '1\n' },
      { currency: 'USD' },
      { currency: 'mxn' },
      { unit: 'OTHER' },
      { taxBasis: 'UNKNOWN' },
    ])
      bad({
        ...order(),
        lines: [
          {
            ...line(),
            informedUnitCost: {
              amount: null,
              currency: null,
              unit: null,
              taxBasis: null,
              ...change,
            },
          },
        ],
      });
  });
  it('parses CAS envelopes, raw headers and closed scalar queries', () => {
    expect(
      parsePurchaseOrderReplace({ expectedVersion: 1, order: order() }),
    ).toEqual({ expectedVersion: 1, order: order() });
    expect(
      parsePurchaseOrderDelete({ expectedVersion: Number.MAX_SAFE_INTEGER }),
    ).toEqual({ expectedVersion: Number.MAX_SAFE_INTEGER });
    for (const expectedVersion of [
      0,
      -1,
      1.5,
      '1',
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() =>
        parsePurchaseOrderReplace({ expectedVersion, order: order() }),
      ).toThrow('MALFORMED');
      expect(() => parsePurchaseOrderDelete({ expectedVersion })).toThrow(
        'MALFORMED',
      );
    }
    expect(() =>
      parsePurchaseOrderDelete({ expectedVersion: 1, extra: true }),
    ).toThrow('MALFORMED');
    expect(parsePurchaseOrderIdempotencyKey(['IDEMPOTENCY-KEY', ' key '])).toBe(
      ' key ',
    );
    expect(() =>
      parsePurchaseOrderIdempotencyKey([
        'Idempotency-Key',
        'a',
        'Idempotency-Key',
        'a',
      ]),
    ).toThrow('MALFORMED');
    expect(parsePurchaseOrderListQuery({})).toEqual({ limit: 25 });
    expect(
      parsePurchaseOrderListQuery({
        supplierId: id,
        limit: '100',
        cursor: 'opaque+/=',
      }),
    ).toEqual({ supplierId: id, limit: 100, cursor: 'opaque+/=' });
    for (const query of [
      { limit: '01' },
      { limit: '101' },
      { limit: '1\n' },
      { limit: 1 },
      { limit: ['1'] },
      { cursor: '' },
      { supplierId: null },
      { extra: true },
    ])
      expect(() => parsePurchaseOrderListQuery(query)).toThrow('MALFORMED');
  });
  it('normalizes search edges only and bounds effective Unicode codepoints', () => {
    expect(
      parsePurchaseOrderListQuery({ search: '  É  Supplier%_\\\\  ' }),
    ).toEqual({
      limit: 25,
      search: 'É  Supplier%_\\\\',
    });
    for (const search of ['', ' \t\n ', ' '.repeat(1000)])
      expect(parsePurchaseOrderListQuery({ search })).toEqual({ limit: 25 });
    expect(
      parsePurchaseOrderListQuery({ search: `  ${'😀'.repeat(200)}  ` }),
    ).toEqual({ limit: 25, search: '😀'.repeat(200) });
  });
  it.each([
    '😀'.repeat(201),
    '\0 term ',
    ' term\0 ',
    '\ud800 term ',
    ' term\udfff ',
    ['term', 'term'],
    { value: 'term' },
    null,
    1,
    undefined,
  ])('rejects invalid raw search %#', (search) => {
    expect(() => parsePurchaseOrderListQuery({ search })).toThrow('MALFORMED');
  });
  it('hashes in schema order, preserving CAS and strings', () => {
    const body = order();
    expect(hashPurchaseOrderBody('create', body)).toBe(
      hashPurchaseOrderBody('create', {
        lines: body.lines,
        location: body.location,
        note: body.note,
        supplierId: body.supplierId,
      }),
    );
    expect(
      hashPurchaseOrderBody('replace', { expectedVersion: 1, order: body }),
    ).not.toBe(
      hashPurchaseOrderBody('replace', { expectedVersion: 2, order: body }),
    );
    expect(hashPurchaseOrderBody('delete', { expectedVersion: 1 })).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(hashPurchaseOrderBody('create', body)).not.toBe(
      hashPurchaseOrderBody('create', { ...body, note: '' }),
    );
    expect(() =>
      hashPurchaseOrderBody('create', { ...body, ignored: true }),
    ).toThrow('MALFORMED');
  });
  it('hashes nested fields in fixed order but preserves line order', () => {
    const first = {
      ...line(),
      informedUnitCost: {
        amount: '1.00',
        currency: 'MXN',
        unit: 'UNIDAD',
        taxBasis: 'INCLUDES_TAX',
      },
    };
    const second = {
      ...line(),
      lineId: '10000000-0000-4000-8000-000000000002',
    };
    const a = { ...order(), lines: [first, second] };
    const b = {
      ...order(),
      lines: [
        {
          informedUnitCost: {
            taxBasis: 'INCLUDES_TAX',
            unit: 'UNIDAD',
            currency: 'MXN',
            amount: '1.00',
          },
          orderedQuantity: null,
          variantId: null,
          productId: null,
          lineId: id,
        },
        second,
      ],
    };
    expect(hashPurchaseOrderBody('create', a)).toBe(
      hashPurchaseOrderBody('create', b),
    );
    expect(hashPurchaseOrderBody('create', a)).not.toBe(
      hashPurchaseOrderBody('create', { ...a, lines: [second, first] }),
    );
  });
  it('maps value-free errors including command codes', () => {
    expect(
      purchaseOrderErrorEnvelope(new PurchaseOrderContractError('MALFORMED')),
    ).toEqual({ statusCode: 400, error: 'MALFORMED' });
    expect(
      purchaseOrderErrorEnvelope(
        new PurchaseOrderContractError('ORDER_VERSION_CONFLICT'),
      ),
    ).toEqual({ statusCode: 409, error: 'ORDER_VERSION_CONFLICT' });
    expect(purchaseOrderErrorEnvelope(new Error('private'))).toEqual({
      statusCode: 500,
      error: 'INTERNAL_ERROR',
    });
    try {
      parseOrderInput({ ...order(), supplierId: 'private' });
    } catch (error) {
      expect(error).toBeInstanceOf(PurchaseOrderContractError);
      expect(purchaseOrderErrorEnvelope(error)).toEqual({
        statusCode: 400,
        error: 'MALFORMED',
      });
    }
  });
});
