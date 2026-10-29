import {
  parseVocabularyShapeV2 as parse,
  type VocabularyV2,
} from './editorial-vocabulary-shape-v2';
import * as definitions from './editorial-vocabulary-definition-v2';
import * as families from './editorial-vocabulary-family-shape-v2';

const empty = (): VocabularyV2 => ({
  semanticsVersion: 'editorial-production-1',
  families: [],
  definitions: [],
});
const family = (): families.FamilyV2 => ({
  id: ' family ',
  code: 'custom',
  label: ' Original ',
  minimumContractVersion: 2,
  bindings: [
    {
      definitionId: 'missing',
      definitionCode: 'unresolved',
      owner: 'product',
      sortOrder: -2,
      exposure: 'INTERNAL',
      searchable: false,
      publicationCheck: 'when_asserted',
      policy: { route: 'pending' },
    },
  ],
});
const definition = (
  type: definitions.DefinitionV2['type'],
): definitions.DefinitionV2 => {
  const base = { id: type, code: type, label: ' Same ' };
  if (type === 'text' || type === 'boolean') return { ...base, type };
  if (type === 'number' || type === 'range')
    return {
      ...base,
      type,
      units:
        type === 'number'
          ? [{ code: null, label: null, sortOrder: 8 }]
          : [{ code: 'kg', label: ' Kg ', sortOrder: -1 }],
      numericPolicy: {
        status: 'resolved',
        magnitude: ' custom ',
        integer: false,
        lower: null,
        lowerInclusive: false,
        upper: 9,
        upperInclusive: true,
      },
    };
  return {
    ...base,
    type,
    options: [
      { code: 'z', label: 'Adulto', archived: true, sortOrder: 8 },
      { code: 'a', label: 'Adulto', archived: false, sortOrder: -1 },
    ],
    groups: [{ code: 'group', label: ' Group ', optionCodes: ['z', 'a'] }],
    aliases: [{ label: ' Mayor ', optionCode: 'z' }],
  };
};
const fixture = (): VocabularyV2 => ({
  ...empty(),
  families: [family()],
  definitions: ['multi', 'number', 'text', 'range', 'boolean', 'single'].map(
    (type) => definition(type as definitions.DefinitionV2['type']),
  ),
});
const error = new TypeError('Expected a vocabulary shape V2');
const capture = (run: () => unknown): unknown => {
  try {
    run();
  } catch (caught) {
    return caught;
  }
  throw new Error('Expected rejection');
};
function detached(output: unknown, input: unknown): void {
  if (input === null || typeof input !== 'object') return;
  expect(output).not.toBe(input);
  for (const key of Object.keys(input))
    detached(
      (output as Record<string, unknown>)[key],
      (input as Record<string, unknown>)[key],
    );
}

describe('dormant vocabulary root shape V2', () => {
  it('accepts an empty root', () => expect(parse(empty())).toEqual(empty()));

  it.each([1, 2] as const)(
    'accepts custom families at version %i and unresolved references',
    (version) => {
      const input = fixture();
      input.families[0].minimumContractVersion = version;
      expect(parse(input)).toEqual(input);
    },
  );

  it('composes all six public definition parsers without changing text, order, nulls or archives', () => {
    const input = fixture();
    expect(parse(input).definitions).toEqual(
      input.definitions.map(definitions.validateDefinitionV2),
    );
    expect(parse(input).families).toEqual(
      input.families.map(families.parseFamilyShapeV2),
    );
    expect(parse(input)).toEqual(input);
  });

  it('requires each exact root key and forbids extras', () => {
    for (const key of Object.keys(empty())) {
      const input = { ...empty() } as Record<string, unknown>;
      delete input[key];
      expect(() => parse(input)).toThrow(error);
    }
    expect(() => parse({ ...empty(), extra: null })).toThrow(error);
  });

  it.each([null, [], 1, 'root', true])(
    'rejects non-record roots %#',
    (input) => {
      expect(() => parse(input)).toThrow(error);
    },
  );
  it.each(['EDITORIAL-PRODUCTION-1', 'editorial-production-2', '', null, 1])(
    'rejects wrong semantics literal %#',
    (semanticsVersion) => {
      expect(() => parse({ ...empty(), semanticsVersion })).toThrow(error);
    },
  );
  it.each(['families', 'definitions'])('requires an array for %s', (key) => {
    for (const value of [null, {}, 'array', 1])
      expect(() => parse({ ...empty(), [key]: value })).toThrow(error);
  });

  it.each([
    ['families', 'id'],
    ['families', 'code'],
    ['definitions', 'id'],
    ['definitions', 'code'],
  ] as const)(
    'rejects independent exact %s %s collisions',
    (namespace, key) => {
      const input = fixture();
      if (namespace === 'families')
        input.families.push({ ...family(), id: 'other', code: 'other' });
      input[namespace][1][key] = input[namespace][0][key];
      expect(() => parse(input)).toThrow(error);
    },
  );

  it('allows cross-namespace equality, homonymous labels and exact-but-not-normalized identities', () => {
    const input = fixture();
    input.families = [family(), { ...family(), id: 'family', code: 'CUSTOM' }];
    input.families[0].id = input.definitions[0].id;
    input.families[0].code = input.definitions[0].code;
    input.definitions[1].id = 'MULTI';
    input.definitions[1].code = ' multi ';
    expect(parse(input)).toEqual(input);
  });

  it.each([
    [
      'family',
      () => ({ ...empty(), families: [{ ...family(), label: '' }] }),
      'Expected a family shape V2',
    ],
    [
      'simple',
      () => ({
        ...empty(),
        definitions: [{ ...definition('text'), extra: 1 }],
      }),
      'Expected a simple definition V2',
    ],
    [
      'numeric',
      () => ({
        ...empty(),
        definitions: [
          {
            ...definition('range'),
            units: [{ code: null, label: null, sortOrder: 0 }],
          },
        ],
      }),
      'Expected a numeric definition V2',
    ],
    [
      'choice',
      () => ({
        ...empty(),
        definitions: [
          {
            ...definition('multi'),
            aliases: [{ label: 'Adulto', optionCode: 'z' }],
          },
        ],
      }),
      'Expected a choice definition V2',
    ],
  ] as const)('propagates invalid %s leaf rejection', (_, make, message) => {
    expect(() => parse(make())).toThrow(new TypeError(message));
  });

  it('propagates Unicode runtime failure unchanged outside the guard catch', () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      process.versions,
      'unicode',
    )!;
    try {
      Object.defineProperty(process.versions, 'unicode', {
        ...descriptor,
        value: '16.0',
      });
      const leaf = definition('multi');
      const direct = capture(() => definitions.validateDefinitionV2(leaf));
      expect(direct).toBeInstanceOf(Error);
      expect(direct).not.toBeInstanceOf(TypeError);
      const spy = jest
        .spyOn(definitions, 'validateDefinitionV2')
        .mockImplementationOnce(() => {
          throw direct;
        });
      try {
        expect(capture(() => parse({ ...empty(), definitions: [leaf] }))).toBe(
          direct,
        );
      } finally {
        spy.mockRestore();
      }
      expect(capture(() => parse({ ...empty(), definitions: [leaf] }))).toEqual(
        direct,
      );
    } finally {
      Object.defineProperty(process.versions, 'unicode', descriptor);
    }
  });

  it.each(['root', 'nested', 'sparse', 'cyclic'])(
    'guards the entire %s tree before side reads or leaf calls',
    (kind) => {
      const input = fixture();
      const getter = jest.fn(() => 'editorial-production-1');
      if (kind === 'root')
        Object.defineProperty(input, 'semanticsVersion', {
          enumerable: true,
          get: getter,
        });
      if (kind === 'nested')
        Object.defineProperty(input.definitions[0], 'label', {
          enumerable: true,
          get: getter,
        });
      if (kind === 'sparse')
        input.definitions = new Array<definitions.DefinitionV2>(1);
      if (kind === 'cyclic')
        (input as unknown as Record<string, unknown>).cycle = input;
      const familySpy = jest.spyOn(families, 'parseFamilyShapeV2');
      const definitionSpy = jest.spyOn(definitions, 'validateDefinitionV2');
      try {
        expect(() => parse(input)).toThrow(error);
        expect(getter).not.toHaveBeenCalled();
        expect(familySpy).not.toHaveBeenCalled();
        expect(definitionSpy).not.toHaveBeenCalled();
      } finally {
        familySpy.mockRestore();
        definitionSpy.mockRestore();
      }
    },
  );

  it('deeply isolates both directions including nested policy tests and all definition collections', () => {
    const input = fixture();
    input.families[0].bindings[0].policy = {
      route: 'option_cases',
      cases: [
        {
          code: 'case',
          when: [
            {
              definitionCode: 'missing',
              operator: 'equals_set',
              optionCodes: ['z'],
            },
          ],
          applicability: 'applicable',
          required: false,
          allowNA: true,
          evidenceRequired: false,
          documentary: 'unresolved',
        },
      ],
    };
    const before = structuredClone(input);
    const output = parse(input);
    expect(output).toEqual(before);
    detached(output, input);
    const mutate = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return;
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (typeof record[key] === 'string') record[key] = 'changed';
        else mutate(record[key]);
      }
      if (Array.isArray(value)) value.push(null);
    };
    const second = parse(input);
    mutate(second);
    expect(input).toEqual(before);
    mutate(input);
    expect(output).toEqual(before);
  });
});
