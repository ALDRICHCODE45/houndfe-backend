import { buildProductionVocabularyManifest } from '../../../prisma/editorial-production-vocabulary.manifest';
import {
  NumericDefinitionV2,
  validateNumericDefinitionV2 as parse,
} from './editorial-vocabulary-numeric-v2';

const message = 'Expected a numeric definition V2';
const pending = (): NumericDefinitionV2 => ({
  id: 'id',
  code: 'measure',
  label: 'Measure',
  type: 'number',
  units: [{ code: 'cm', label: 'Centímetros', sortOrder: -2 }],
  numericPolicy: { status: 'pending' },
});
const resolved = (): NumericDefinitionV2 => ({
  ...pending(),
  numericPolicy: {
    status: 'resolved',
    magnitude: 'custom',
    integer: false,
    lower: -10,
    lowerInclusive: true,
    upper: 10,
    upperInclusive: false,
  },
});
const rejects = (input: unknown) => {
  expect(() => parse(input)).toThrow(new TypeError(message));
};

describe('validateNumericDefinitionV2 (dormant metadata)', () => {
  it.each([pending(), resolved()])('preserves number metadata %#', (input) => {
    expect(parse(input)).toEqual(input);
  });

  it.each([
    [-20, true, 0, false],
    [null, false, null, false],
    [2, true, 2, true],
  ])(
    'accepts range bounds %j/%j/%j/%j',
    (lower, lowerInclusive, upper, upperInclusive) => {
      const input = resolved();
      input.type = 'range';
      Object.assign(input.numericPolicy, {
        lower,
        lowerInclusive,
        upper,
        upperInclusive,
      });
      expect(parse(input)).toEqual(input);
    },
  );

  it('allows empty units, null number units, and any string magnitude', () => {
    const input = resolved();
    input.units = [];
    Object.assign(input.numericPolicy, { magnitude: '' });
    expect(parse(input)).toEqual(input);
    input.units = [
      { code: null, label: null, sortOrder: Number.MIN_SAFE_INTEGER },
    ];
    expect(parse(input)).toEqual(input);
    input.type = 'range';
    input.units = [];
    expect(parse(input)).toEqual(input);
  });

  it('requires every key and rejects extras at each object level', () => {
    const original = resolved();
    const objects = [original, original.units[0], original.numericPolicy];
    for (const [index, object] of objects.entries()) {
      for (const key of [...Object.keys(object), 'extra']) {
        const input = resolved();
        const targets = [input, input.units[0], input.numericPolicy];
        const target = targets[index] as unknown as Record<string, unknown>;
        if (key === 'extra') target[key] = true;
        else delete target[key];
        const before = JSON.stringify(input);
        rejects(input);
        expect(JSON.stringify(input)).toBe(before);
      }
    }
    rejects({ ...pending(), numericPolicy: {} });
    rejects({
      ...pending(),
      numericPolicy: { status: 'pending', lower: null },
    });
    rejects({ ...pending(), options: [] });
    rejects({
      ...resolved(),
      numericPolicy: { ...resolved().numericPolicy, route: 'pending' },
    });
  });

  it.each([
    ['id', ''],
    ['id', ' \t'],
    ['code', '\ud800'],
    ['label', '\udfff'],
    ['label', null],
    ['code', 3],
    ['type', 'text'],
    ['type', null],
    ['units', null],
    ['units', {}],
    ['numericPolicy', null],
    ['numericPolicy', { status: 'other' }],
  ])('rejects definition %s=%j', (key, value) => {
    rejects({ ...pending(), [key]: value });
  });

  it.each([null, undefined, false, 1, 'definition', [], new Date()])(
    'rejects nonobjects %j',
    rejects,
  );

  it.each([
    ['magnitude', 1],
    ['integer', 0],
    ['integer', 'true'],
    ['lowerInclusive', null],
    ['upperInclusive', 1],
    ['lower', '0'],
    ['upper', false],
    ['lower', NaN],
    ['upper', Infinity],
    ['lower', -Infinity],
    ['status', 'pending'],
  ])('rejects policy %s=%j', (key, value) => {
    const input = resolved();
    Object.assign(input.numericPolicy, { [key]: value });
    rejects(input);
  });

  it.each([
    [2, true, 1, true],
    [1, false, 1, true],
    [1, true, 1, false],
    [1, false, 1, false],
    [null, true, 1, true],
    [0, true, null, true],
  ])(
    'rejects contradictory bounds %#',
    (lower, lowerInclusive, upper, upperInclusive) => {
      const input = resolved();
      Object.assign(input.numericPolicy, {
        lower,
        lowerInclusive,
        upper,
        upperInclusive,
      });
      rejects(input);
    },
  );

  it.each([
    ['sortOrder', 0.5],
    ['sortOrder', Number.MAX_SAFE_INTEGER + 1],
    ['sortOrder', '0'],
    ['sortOrder', Infinity],
    ['sortOrder', null],
    ['code', ''],
    ['label', '\n'],
    ['code', null],
    ['label', null],
    ['code', false],
    ['label', 42],
  ])('rejects unit %s=%j', (key, value) => {
    const input = pending();
    Object.assign(input.units[0], { [key]: value });
    rejects(input);
  });

  it('rejects duplicate named/null units and range null units', () => {
    for (const unit of [
      pending().units[0],
      { code: null, label: null, sortOrder: 0 },
    ]) {
      rejects({ ...pending(), units: [unit, { ...unit, sortOrder: 99 }] });
    }
    rejects({
      ...pending(),
      type: 'range',
      units: [{ code: null, label: null, sortOrder: 0 }],
    });
  });

  it('preserves supplementary Unicode and nonblank surrounding whitespace', () => {
    const input = resolved();
    input.id = ' 🐕 id ';
    input.code = '\tmaß🐾 ';
    input.label = ' e\u0301 🐕 ';
    input.units[0].code = ' cm🐕 ';
    input.units[0].label = ' centímetros ';
    Object.assign(input.numericPolicy, { magnitude: ' \t🐕 ' });
    expect(parse(input)).toEqual(input);
  });

  it('rejects undefined, sparse/decorated arrays and getters without invoking them', () => {
    rejects({ ...pending(), id: undefined });
    rejects({ ...pending(), units: new Array(1) });
    const decorated = Object.assign(pending().units, { extra: true });
    rejects({ ...pending(), units: decorated });
    const getter = jest.fn(() => 'id');
    const input = pending();
    Object.defineProperty(input, 'id', { enumerable: true, get: getter });
    rejects(input);
    const units = pending().units;
    Object.defineProperty(units, '0', { enumerable: true, get: getter });
    rejects({ ...pending(), units });
    expect(getter).not.toHaveBeenCalled();
  });

  it('accepts frozen input and detaches every mutable level without sorting', () => {
    const input = resolved();
    input.units.push({ code: 'mm', label: 'Milímetros', sortOrder: -10 });
    input.units.forEach(Object.freeze);
    Object.freeze(input.units);
    Object.freeze(input.numericPolicy);
    Object.freeze(input);
    const before = JSON.stringify(input);
    const output = parse(input);
    expect(output).toEqual(input);
    expect(output.units.map((unit) => unit.code)).toEqual(['cm', 'mm']);
    output.id = 'changed';
    output.units[0].label = 'changed';
    output.units.reverse();
    Object.assign(output.numericPolicy, { magnitude: 'changed' });
    expect(JSON.stringify(input)).toBe(before);
  });

  it('accepts and preserves all 25 production numeric definitions with synthetic IDs', () => {
    const numeric = buildProductionVocabularyManifest().definitions.filter(
      (definition) =>
        definition.type === 'number' || definition.type === 'range',
    );
    expect(numeric).toHaveLength(25);
    for (const definition of numeric) {
      const input = { id: `synthetic:${definition.code}`, ...definition };
      expect(parse(input)).toEqual(input);
    }
  });
});
