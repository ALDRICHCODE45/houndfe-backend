import { parseValueShapeV2, type ValueV2 } from './editorial-value-shape-v2';

const payloads = [
  { type: 'text', value: '\ud800' },
  { type: 'single', value: '' },
  { type: 'boolean', value: false },
  { type: 'number', value: -0, unit: null },
  { type: 'number', value: -1.5, unit: '\ud800' },
  { type: 'multi', value: ['z', '', 'z', '\ud800'] },
  { type: 'range', min: 3.5, max: -2, unit: '' },
] as const;
const evidence = { sourceRef: '\ud800', verifiedOn: 'not-a-date' };
const known = (payload: unknown = payloads[0], proof: unknown = null) => ({
  code: '',
  owner: 'product',
  variantId: '\ud800',
  state: 'known',
  payload,
  evidence: proof,
});
const absent = (state = 'unknown', owner = 'sellable') => ({
  code: '\ud800',
  owner,
  variantId: null,
  state,
  evidence: null,
});
const reject = (input: unknown, message = 'Expected a value shape V2') => {
  expect(() => parseValueShapeV2(input)).toThrow(new TypeError(message));
};

describe('parseValueShapeV2 (S2 pre-receipt shape only)', () => {
  it.each(payloads)('preserves and detaches known $type', (payload) => {
    for (const proof of [null, evidence]) {
      const input = Object.freeze(known(Object.freeze(payload), proof));
      if (payload.type === 'multi') Object.freeze(payload.value);
      if (proof) Object.freeze(proof);
      const result: ValueV2 = parseValueShapeV2(input);
      expect(result).toEqual(input);
      expect(result).not.toBe(input);
      expect(result.state).toBe('known');
      if (result.state !== 'known') throw new Error('Expected known branch');
      expect(result.payload).not.toBe(payload);
      if (result.payload.type === 'multi' && payload.type === 'multi') {
        expect(result.payload.value).not.toBe(payload.value);
      }
      if (proof) expect(result.evidence).not.toBe(proof);
      if (
        result.payload.type === 'number' &&
        payload.type === 'number' &&
        Object.is(payload.value, -0)
      ) {
        expect(Object.is(result.payload.value, -0)).toBe(true);
      }
      expect(input).toEqual(known(payload, proof));
    }
  });

  it.each(['unknown', 'not_applicable'])(
    'keeps %s distinct and closed',
    (state) => {
      for (const owner of ['product', 'sellable']) {
        const input = Object.freeze(absent(state, owner));
        const result = parseValueShapeV2(input);
        expect(result).toEqual(input);
        expect(result).not.toBe(input);
        expect(Object.hasOwn(result, 'payload')).toBe(false);
        reject({ ...input, payload: undefined });
        reject({ ...input, evidence });
      }
    },
  );

  it('allows sellable known values and detached output mutation', () => {
    const payload = Object.freeze({
      type: 'multi',
      value: Object.freeze(['b', 'a', 'b']),
    });
    const input = Object.freeze({
      ...known(payload, Object.freeze(evidence)),
      owner: 'sellable',
    });
    const result = parseValueShapeV2(input);
    if (result.state !== 'known' || result.payload.type !== 'multi') {
      throw new Error('Expected known multi branch');
    }
    result.payload.value.push('new');
    if (result.evidence) result.evidence.sourceRef = 'changed';
    expect(payload.value).toEqual(['b', 'a', 'b']);
    expect(input.evidence).toEqual(evidence);
  });

  it('distinguishes known false from unknown and not applicable', () => {
    const result = parseValueShapeV2(known(payloads[2]));
    expect(result).toMatchObject({ state: 'known', payload: { value: false } });
    expect(result).not.toEqual(parseValueShapeV2(absent()));
    expect(result).not.toEqual(parseValueShapeV2(absent('not_applicable')));
  });

  it.each([known(), absent(), absent('not_applicable')])(
    'requires every key and forbids extras in $state',
    (input) => {
      for (const key of Object.keys(input)) {
        const missing = { ...input };
        Reflect.deleteProperty(missing, key);
        reject(missing);
      }
      reject({ ...input, extra: null });
    },
  );

  it.each([
    null,
    undefined,
    false,
    1,
    '',
    [],
    { ...known(), state: 'KNOWN' },
    { ...known(), state: null },
    { ...known(), owner: 'variant' },
    { ...known(), owner: null },
    { ...known(), code: 1 },
    { ...known(), variantId: 1 },
    { ...known(), variantId: undefined },
  ])('rejects invalid root primitives/enums %#', (input) => reject(input));

  it.each([
    { type: 'text', value: false },
    { type: 'single', value: 1 },
    { type: 'boolean', value: 'false' },
    { type: 'number', value: Infinity, unit: null },
    { type: 'multi', value: ['x', 1] },
    { type: 'range', min: 1, max: NaN, unit: 'cm' },
    null,
  ])('retains payload leaf rejection %#', (payload) => {
    reject(known(payload), 'Expected a known payload shape V2');
  });

  it.each([
    {},
    false,
    { ...evidence, verifiedOn: 1 },
    { ...evidence, extra: 1 },
  ])('retains evidence leaf rejection %#', (proof) =>
    reject(known(payloads[0], proof), 'Expected an evidence shape V2'),
  );

  it.each(Object.keys(known()))(
    'rejects root accessor %s without execution',
    (key) => {
      const getter = jest.fn(() => {
        throw new Error('must not execute');
      });
      const input = Object.defineProperty(known(), key, { get: getter });
      reject(input);
      expect(getter).not.toHaveBeenCalled();
    },
  );

  it('rejects hidden, symbol, inherited and exotic roots', () => {
    reject(Object.defineProperty(known(), 'code', { enumerable: false }));
    reject(Object.defineProperty(known(), 'hidden', { value: 1 }));
    reject({ ...known(), [Symbol('extra')]: 1 });
    reject(Object.create(known()));
    reject(Object.assign(Object.create({}), known()));
    reject(new Date());
  });

  it('accepts null prototypes but returns ordinary detached literals', () => {
    const payload = Object.assign(Object.create(null), payloads[0]) as object;
    const proof = Object.assign(Object.create(null), evidence) as object;
    const input = Object.assign(
      Object.create(null),
      known(payload, proof),
    ) as object;
    const result = parseValueShapeV2(input);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    if (result.state !== 'known') throw new Error('Expected known branch');
    expect(Object.getPrototypeOf(result.payload)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(result.evidence)).toBe(Object.prototype);
    expect(result).toEqual(known(payloads[0], evidence));
  });

  it.each(['payload', 'evidence'])(
    'delegates nested %s descriptors without getters',
    (slot) => {
      const getter = jest.fn(() => {
        throw new Error('must not execute');
      });
      const nested = slot === 'payload' ? { ...payloads[0] } : { ...evidence };
      Object.defineProperty(
        nested,
        slot === 'payload' ? 'value' : 'sourceRef',
        { get: getter },
      );
      reject(
        { ...known(), [slot]: nested },
        slot === 'payload'
          ? 'Expected a known payload shape V2'
          : 'Expected an evidence shape V2',
      );
      expect(getter).not.toHaveBeenCalled();
    },
  );

  it.each(['root', 'payload', 'evidence'])(
    'propagates reflection failures at %s by identity',
    (slot) => {
      for (const trap of [
        'getPrototypeOf',
        'ownKeys',
        'getOwnPropertyDescriptor',
      ]) {
        for (const sentinel of [
          new Error('reflection'),
          new TypeError('Expected a value shape V2'),
          'non-error',
        ]) {
          const target =
            slot === 'evidence'
              ? evidence
              : slot === 'payload'
                ? payloads[0]
                : known();
          const proxy = new Proxy(
            { ...target },
            {
              [trap]: () => {
                // eslint-disable-next-line @typescript-eslint/only-throw-error -- prove non-Error identity propagation
                throw sentinel;
              },
            },
          );
          const input = slot === 'root' ? proxy : { ...known(), [slot]: proxy };
          let caught: unknown;
          try {
            parseValueShapeV2(input);
          } catch (error) {
            caught = error;
          }
          expect(caught).toBe(sentinel);
        }
      }
    },
  );
});
