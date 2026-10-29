import {
  SimpleDefinitionV2,
  validateSimpleDefinitionV2,
} from './editorial-vocabulary-simple-v2';

const definition = (): SimpleDefinitionV2 => ({
  id: 'definition-id',
  code: 'care.instructions',
  label: 'Instructions',
  type: 'text',
});

function rejects(input: unknown): void {
  const descriptors =
    input !== null && typeof input === 'object'
      ? Object.getOwnPropertyDescriptors(input)
      : undefined;
  expect(() => validateSimpleDefinitionV2(input)).toThrow(
    new TypeError('Expected a simple definition V2'),
  );
  if (descriptors) {
    expect(Object.getOwnPropertyDescriptors(input)).toEqual(descriptors);
  }
}

describe('validateSimpleDefinitionV2', () => {
  it.each(['text', 'boolean'] as const)('copies frozen %s metadata', (type) => {
    const input = Object.freeze({ ...definition(), type });
    const result = validateSimpleDefinitionV2(input);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
    expect(Object.keys(result)).toEqual(['id', 'code', 'label', 'type']);
    result.label = 'Changed';
    expect(input.label).toBe('Instructions');
  });

  it('preserves supplementary/decomposed Unicode and surrounding whitespace', () => {
    const input = {
      ...definition(),
      id: ' 🐕 ',
      code: ' e\u0301 ',
      label: ' 雪 ',
    };
    expect(validateSimpleDefinitionV2(input)).toEqual(input);
  });

  it('accepts a null-prototype data record without changing its prototype', () => {
    const input: unknown = Object.assign(Object.create(null), definition());
    expect(validateSimpleDefinitionV2(input)).toEqual(definition());
    expect(Object.getPrototypeOf(input)).toBeNull();
  });

  it.each(['id', 'code', 'label', 'type'])('requires %s', (key) => {
    const input: Record<string, unknown> = { ...definition() };
    delete input[key];
    rejects(input);
  });

  it.each([
    'value',
    'options',
    'numericPolicy',
    'units',
    'groups',
    'aliases',
    'extra',
  ])('rejects extra %s', (key) => rejects({ ...definition(), [key]: null }));

  it.each(['id', 'code', 'label'])('rejects invalid %s identities', (key) => {
    for (const value of [
      null,
      undefined,
      false,
      0,
      {},
      [],
      '',
      ' \t\n',
      '\ud800',
      '\udfff',
    ]) {
      rejects({ ...definition(), [key]: value });
    }
  });

  it.each([
    'number',
    'range',
    'single',
    'multi',
    '',
    ' text ',
    null,
    true,
    1,
    {},
  ])('rejects non-simple type %p', (type) =>
    rejects({ ...definition(), type }),
  );

  it.each([
    null,
    undefined,
    false,
    true,
    0,
    'text',
    [],
    new Date(),
    new Map(),
    /x/,
  ])('rejects non-record input %p', rejects);

  it.each(['id', 'code', 'label', 'type', 'extra'])(
    'rejects getter %s without invocation',
    (key) => {
      const getter = jest.fn(() => 'text');
      const input = Object.defineProperty(definition(), key, {
        enumerable: true,
        get: getter,
      });
      rejects(input);
      expect(getter).not.toHaveBeenCalled();
    },
  );

  it('rejects non-data descriptors, prototypes and malformed trees', () => {
    const cycle: Record<string, unknown> = { ...definition() };
    cycle.extra = cycle;
    const setter = jest.fn();
    const malformed = [
      Object.create(definition()) as unknown,
      Object.assign(
        Object.create({ inherited: true }),
        definition(),
      ) as unknown,
      Object.defineProperty(definition(), 'id', { enumerable: false }),
      Object.defineProperty(definition(), 'label', { set: setter }),
      { ...definition(), [Symbol('hidden')]: true },
      { ...definition(), extra: { bad: undefined } },
      { ...definition(), extra: Number.NaN },
      { ...definition(), extra: () => 'not data' },
      cycle,
    ];
    malformed.forEach(rejects);
    expect(setter).not.toHaveBeenCalled();
  });
});
