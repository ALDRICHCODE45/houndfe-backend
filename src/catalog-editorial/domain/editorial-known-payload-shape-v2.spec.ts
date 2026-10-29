import {
  parseKnownPayloadShapeV2,
  type KnownPayloadV2,
} from './editorial-known-payload-shape-v2';

const message = 'Expected a known payload shape V2';
const valid: KnownPayloadV2[] = [
  { type: 'text', value: '' },
  { type: 'single', value: 'unknown-option' },
  { type: 'boolean', value: false },
  { type: 'number', value: -1.5, unit: null },
  { type: 'number', value: -0, unit: 'unknown-unit' },
  { type: 'multi', value: ['z', '', 'z', '\ud800', 'a'] },
  { type: 'multi', value: [] },
  { type: 'range', min: -5, max: 30, unit: '°C' },
  { type: 'range', min: 2.5, max: 2.5, unit: '' },
  { type: 'range', min: 4, max: -0, unit: '\ud800' },
  { type: 'text', value: '\ud800  ' },
];

function rejected(input: unknown) {
  expect(() => parseKnownPayloadShapeV2(input)).toThrow(TypeError);
  expect(() => parseKnownPayloadShapeV2(input)).toThrow(new TypeError(message));
}

function getterObject(key: string, enumerable = true) {
  const getter = jest.fn(() => 'unexpected');
  const input = Object.defineProperty({ type: 'text', value: 'ok' }, key, {
    get: getter,
    enumerable,
  });
  return { input, getter };
}

describe('parseKnownPayloadShapeV2 (S2, pre-receipt shape only)', () => {
  it.each(valid)('preserves and detaches frozen $type input: %j', (input) => {
    if (input.type === 'multi') Object.freeze(input.value);
    Object.freeze(input);
    const output = parseKnownPayloadShapeV2(input);
    expect(output).toStrictEqual(input);
    expect(output).not.toBe(input);
    if (input.type === 'multi' && output.type === 'multi') {
      expect(output.value).not.toBe(input.value);
      expect(output.value).toEqual(input.value);
    }
    if (input.type === 'number' && output.type === 'number') {
      expect(Object.is(output.value, input.value)).toBe(true);
    }
    if (input.type === 'range' && output.type === 'range') {
      expect(Object.is(output.max, input.max)).toBe(true);
    }
  });

  it('accepts null-prototype objects without adding submitted properties', () => {
    const input: unknown = Object.assign(Object.create(null) as object, {
      type: 'boolean',
      value: false,
    });
    expect(parseKnownPayloadShapeV2(input)).toStrictEqual({
      type: 'boolean',
      value: false,
    });
  });

  it.each(valid)(
    'requires every own key and rejects extras for $type',
    (input) => {
      for (const key of Object.keys(input)) {
        const missing = { ...input } as Record<string, unknown>;
        delete missing[key];
        rejected(missing);
      }
      rejected({ ...input, extra: null });
      rejected(Object.defineProperty({ ...input }, 'hidden', { value: 1 }));
      rejected({ ...input, [Symbol('extra')]: 1 });
    },
  );

  it.each([
    null,
    undefined,
    false,
    1,
    'text',
    [],
    new Date(),
    { type: 'future', value: '' },
    { type: 'Text', value: '' },
    { type: 'text', value: null },
    { type: 'single', value: [] },
    { type: 'boolean', value: 0 },
    { type: 'boolean', value: 'false' },
    { type: 'number', value: '1', unit: null },
    { type: 'number', value: 1n, unit: null },
    { type: 'number', value: new Number(1), unit: null },
    { type: 'number', value: 1, unit: false },
    { type: 'multi', value: 'a' },
    { type: 'multi', value: [1] },
    { type: 'multi', value: [null] },
    { type: 'range', min: '1', max: 2, unit: 'cm' },
    { type: 'range', min: 1, max: null, unit: 'cm' },
    { type: 'range', min: 1, max: 2, unit: null },
    { type: 'range', min: 1, max: 2, unit: 1 },
  ])('rejects wrong shape/primitives: %p', rejected);

  it.each([NaN, Infinity, -Infinity])(
    'rejects nonfinite %s in every numeric slot',
    (value) => {
      rejected({ type: 'number', value, unit: null });
      rejected({ type: 'range', min: value, max: 1, unit: 'cm' });
      rejected({ type: 'range', min: 1, max: value, unit: 'cm' });
    },
  );

  it('rejects inherited fields and exotic prototypes', () => {
    rejected(Object.create({ type: 'text', value: '' }));
    rejected(
      Object.assign(Object.create({ inherited: true }) as object, valid[0]),
    );
  });

  it.each(['type', 'value', 'extra'])(
    'never executes an object getter at %s',
    (key) => {
      const { input, getter } = getterObject(key);
      rejected(input);
      expect(getter).not.toHaveBeenCalled();
    },
  );

  it('rejects nonenumerable required data and accessors without execution', () => {
    rejected(Object.defineProperty({ type: 'text' }, 'value', { value: '' }));
    const { input, getter } = getterObject('value', false);
    rejected(input);
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects sparse, decorated, accessor and exotic arrays without getters', () => {
    const getter = jest.fn(() => 'a');
    const accessor = Object.defineProperty(['a'], '0', { get: getter });
    const hiddenIndex = Object.defineProperty(['a'], '0', {
      enumerable: false,
    });
    const exotic = Object.setPrototypeOf(['a'], null) as unknown;
    const arrays: unknown[] = [
      Array<string>(1),
      // Deliberately exercise a hole between populated indices.
      // eslint-disable-next-line no-sparse-arrays
      ['a', , 'b'],
      accessor,
      hiddenIndex,
      exotic,
      Object.assign(['a'], { extra: 1 }),
      Object.assign(['a'], { [Symbol('extra')]: 1 }),
      Object.defineProperty(['a'], 'hidden', { value: 1 }),
    ];
    for (const value of arrays) rejected({ type: 'multi', value });
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    new Error('reflection'),
    new TypeError(message),
    { sentinel: true },
  ])(
    'propagates unexpected reflection failures by identity: %j',
    (sentinel) => {
      for (const trap of [
        'getPrototypeOf',
        'ownKeys',
        'getOwnPropertyDescriptor',
      ] as const) {
        const handler: ProxyHandler<object> = {
          [trap]: () => {
            // Non-Error reflection failures must also preserve identity.
            // eslint-disable-next-line @typescript-eslint/only-throw-error
            throw sentinel;
          },
        };
        for (const input of [
          new Proxy({ type: 'text', value: '' }, handler),
          { type: 'multi', value: new Proxy(['a'], handler) },
        ]) {
          try {
            parseKnownPayloadShapeV2(input);
            throw new Error('Expected reflection to fail');
          } catch (error) {
            expect(error).toBe(sentinel);
          }
        }
      }
    },
  );
});
