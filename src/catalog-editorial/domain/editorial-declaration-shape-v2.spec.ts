import { parseDeclarationShapeV2 as parse } from './editorial-declaration-shape-v2';

const evidence = { sourceRef: '\ud800', verifiedOn: 'not a date' };
const samples = [
  ['contentMagnitude', 'mass'],
  ['consumable', false],
  ['animalApplied', false],
  ['fitDeterminesChoice', false],
  ['capacityDeterminesChoice', false],
  ['electricalApplies', false],
  [
    'relevantDimensionCodes',
    { codes: ['foreign', '', 'foreign'], toyTypes: [] },
  ],
  ['relevantFitCodes', []],
  ['relevantCapacityCodes', ['foreign', '', 'foreign']],
  ['relevantEquipmentCodes', []],
  ['presentationKind', 'device'],
  ['optionalNonpertinenceCodes', []],
] as const;
const known = (key = 'consumable', value: unknown = false) => ({
  key,
  state: 'known',
  value,
  evidence: { ...evidence },
  basis: '',
});
const unknown = (key = 'consumable') => ({
  key,
  state: 'unknown',
  evidence: null,
});
function reject(input: unknown) {
  expect(() => parse(input)).toThrow(
    new TypeError('Expected a declaration shape V2'),
  );
}

describe('private declaration primitive shape', () => {
  it.each(samples)('preserves known and unknown %s', (key, value) => {
    expect(parse(known(key, value))).toStrictEqual(known(key, value));
    expect(parse(unknown(key))).toStrictEqual(unknown(key));
  });
  it.each(['mass', 'volume', 'count', 'length', 'area'])(
    'accepts magnitude %s',
    (value) =>
      expect(parse(known('contentMagnitude', value))).toStrictEqual(
        known('contentMagnitude', value),
      ),
  );
  it.each(['formulation', 'device', 'packaging'])(
    'accepts presentation %s',
    (value) =>
      expect(parse(known('presentationKind', value))).toStrictEqual(
        known('presentationKind', value),
      ),
  );
  it.each([
    null,
    false,
    1,
    '',
    [],
    new Date(),
    { ...known(), key: 'other' },
    { ...known(), key: 'toString' },
    { ...known(), state: 'not_applicable' },
    { ...known(), state: null },
    known('consumable', 0),
    known('contentMagnitude', 'Mass'),
    known('presentationKind', 'tool'),
    known('relevantFitCodes', 'code'),
    known('relevantEquipmentCodes', [1]),
    known('relevantDimensionCodes', []),
    known('relevantDimensionCodes', { codes: [] }),
    known('relevantDimensionCodes', { codes: [], toyTypes: [], extra: true }),
    known('relevantDimensionCodes', { codes: [], toyTypes: [null] }),
    { ...known(), basis: null },
    { ...known(), extra: true },
    { ...unknown(), value: false },
    { ...unknown(), basis: '' },
    { ...unknown(), evidence },
  ])('rejects malformed declaration %#', reject);
  it.each(samples)('requires evidence and basis for known %s', (key, value) => {
    for (const field of ['key', 'state', 'value', 'evidence', 'basis']) {
      const input: Record<string, unknown> = known(key, value);
      delete input[field];
      reject(input);
    }
    reject({ ...known(key, value), evidence: null });
  });
  it('requires every unknown field and forbids extra keys', () => {
    for (const field of ['key', 'state', 'evidence']) {
      const input: Record<string, unknown> = unknown();
      delete input[field];
      reject(input);
    }
    reject({ ...unknown(), extra: null });
  });
  it('preserves empty and ordered duplicate subsets for every array key', () => {
    for (const key of [
      'relevantFitCodes',
      'relevantCapacityCodes',
      'relevantEquipmentCodes',
      'optionalNonpertinenceCodes',
    ]) {
      for (const value of [[], ['z', '\ud800', '', 'z']]) {
        expect(parse(known(key, value))).toStrictEqual(known(key, value));
      }
    }
    const value = { codes: [], toyTypes: ['z', '', 'z'] };
    expect(parse(known('relevantDimensionCodes', value))).toStrictEqual(
      known('relevantDimensionCodes', value),
    );
  });
  it('preserves leaf errors rather than reclassifying them', () => {
    expect(() => parse({ ...known(), evidence: {} })).toThrow(
      new TypeError('Expected an evidence shape V2'),
    );
  });
  it('accepts null prototypes and detaches frozen nested data', () => {
    const value = Object.freeze({
      codes: Object.freeze(['a', 'b', 'a']),
      toyTypes: Object.freeze(['foreign']),
    });
    const input = Object.freeze(
      Object.assign(Object.create(null) as object, {
        ...known('relevantDimensionCodes', value),
        evidence: Object.freeze(
          Object.assign(Object.create(null) as object, evidence),
        ),
      }),
    );
    const result = parse(input);
    expect(result).toStrictEqual(known('relevantDimensionCodes', value));
    expect(result).not.toBe(input);
    if (result.key !== 'relevantDimensionCodes' || result.state !== 'known')
      throw new Error('wrong branch');
    result.value.codes.push('new');
    result.value.toyTypes[0] = 'changed';
    result.evidence.sourceRef = 'changed';
    expect(value.codes).toEqual(['a', 'b', 'a']);
    expect(value.toyTypes).toEqual(['foreign']);
    expect(Object.getOwnPropertyDescriptor(input, 'evidence')?.value).toEqual(
      evidence,
    );
    const nested = Object.assign(Object.create(null) as object, {
      codes: [],
      toyTypes: [],
    });
    expect(parse(known('relevantDimensionCodes', nested))).toStrictEqual(
      known('relevantDimensionCodes', { codes: [], toyTypes: [] }),
    );
  });
  it('rejects accessors without invoking root, dimension or array getters', () => {
    let reads = 0;
    const accessor = {
      enumerable: true,
      get: () => {
        reads++;
        return false;
      },
    };
    reject(Object.defineProperty(known(), 'value', accessor));
    reject(
      known(
        'relevantDimensionCodes',
        Object.defineProperty({ codes: [], toyTypes: [] }, 'codes', accessor),
      ),
    );
    reject(
      known('relevantFitCodes', Object.defineProperty(['a'], '0', accessor)),
    );
    expect(reads).toBe(0);
  });
  it('rejects hidden, symbol, inherited and decorated data', () => {
    for (const property of ['hidden', Symbol('extra')]) {
      reject(Object.defineProperty(known(), property, { value: true }));
      reject(
        known(
          'relevantDimensionCodes',
          Object.defineProperty({ codes: [], toyTypes: [] }, property, {
            value: true,
          }),
        ),
      );
    }
    reject(Object.create(known()));
    reject(known('relevantFitCodes', new Array(1)));
    reject(known('relevantFitCodes', Object.assign([], { extra: true })));
    reject(known('relevantFitCodes', Object.setPrototypeOf([], null)));
    reject(Object.defineProperty(known(), 'basis', { enumerable: false }));
  });
  it.each([
    new Error('reflection'),
    new TypeError('Expected a declaration shape V2'),
    'sentinel',
  ])('propagates reflection failures by identity %#', (sentinel) => {
    for (const trap of [
      'getPrototypeOf',
      'ownKeys',
      'getOwnPropertyDescriptor',
    ]) {
      for (const location of [
        'root',
        'dimension',
        'array',
        'evidence',
      ] as const) {
        const target = {
          root: known(),
          dimension: { codes: [], toyTypes: [] },
          array: ['code'],
          evidence,
        }[location];
        const proxy = new Proxy(target, {
          [trap]: () => {
            // Non-Error sentinels deliberately verify lossless propagation.
            // eslint-disable-next-line @typescript-eslint/only-throw-error
            throw sentinel;
          },
        });
        const input =
          location === 'root'
            ? proxy
            : location === 'dimension'
              ? known('relevantDimensionCodes', proxy)
              : location === 'array'
                ? known('relevantFitCodes', proxy)
                : { ...known(), evidence: proxy };
        let caught: unknown;
        try {
          parse(input);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBe(sentinel);
      }
    }
  });
});
