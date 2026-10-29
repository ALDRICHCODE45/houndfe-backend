import {
  validateDefinitionV2,
  DefinitionV2,
} from './editorial-vocabulary-definition-v2';
import * as simple from './editorial-vocabulary-simple-v2';
import * as numeric from './editorial-vocabulary-numeric-v2';
import * as choice from './editorial-vocabulary-choice-v2';

const base = { id: 'id', code: 'code', label: ' Original ' };
const simpleFixture = (type: 'text' | 'boolean') => ({ ...base, type });
const numericFixture = (type: 'number' | 'range') => ({
  ...base,
  type,
  units: [{ code: 'kg', label: 'Kilograms', sortOrder: 2 }],
  numericPolicy: { status: 'pending' as const },
});
const choiceFixture = (type: 'single' | 'multi') => ({
  ...base,
  type,
  options: [
    { code: 'a', label: 'Adulto', archived: false, sortOrder: 2 },
    { code: 'b', label: 'Adulto', archived: true, sortOrder: 1 },
  ],
  groups: [{ code: 'both', label: 'Both', optionCodes: ['b', 'a'] }],
  aliases: [{ label: 'Mayor', optionCode: 'a' }],
});

function expectDetached(output: unknown, input: unknown): void {
  if (input === null || typeof input !== 'object') return;
  expect(output).not.toBe(input);
  for (const key of Object.keys(input)) {
    expectDetached(
      (output as Record<string, unknown>)[key],
      (input as Record<string, unknown>)[key],
    );
  }
}

function freezeTree(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  Object.values(value).forEach(freezeTree);
  Object.freeze(value);
}

describe('validateDefinitionV2 (dormant)', () => {
  const fixtures: [DefinitionV2, (input: unknown) => DefinitionV2][] = [
    [simpleFixture('text'), simple.validateSimpleDefinitionV2],
    [simpleFixture('boolean'), simple.validateSimpleDefinitionV2],
    [numericFixture('number'), numeric.validateNumericDefinitionV2],
    [numericFixture('range'), numeric.validateNumericDefinitionV2],
    [choiceFixture('single'), choice.validateChoiceDefinitionV2],
    [choiceFixture('multi'), choice.validateChoiceDefinitionV2],
  ];
  it.each(fixtures)(
    'delegates $type without mutation or normalization',
    (input, leaf) => {
      const before = structuredClone(input);
      freezeTree(input);
      const output = validateDefinitionV2(input);
      expect(output).toEqual(leaf(input));
      expectDetached(output, input);
      expect(input).toEqual(before);
    },
  );

  it.each([
    null,
    [],
    'text',
    { ...base },
    { ...base, type: 'TEXT' },
    { ...base, type: 'unknown' },
    { ...base, type: 1 },
    { ...base, type: null },
    Object.assign(Object.create({ type: 'text' }) as object, base),
  ])('rejects invalid root/discriminant %j', (input) => {
    expect(() => validateDefinitionV2(input)).toThrow(
      new TypeError('Expected a definition V2'),
    );
  });

  it('guards descriptors before reading type', () => {
    const getter = jest.fn(() => 'text');
    const input = Object.defineProperty({ ...base }, 'type', {
      enumerable: true,
      get: getter,
    });
    expect(() => validateDefinitionV2(input)).toThrow(TypeError);
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...simpleFixture('text'), options: [] }, 'simple'],
    [{ ...choiceFixture('single'), units: [] }, 'choice'],
    [
      {
        ...numericFixture('number'),
        units: [{ code: 'kg', label: null, sortOrder: 0 }],
      },
      'numeric',
    ],
    [
      {
        ...choiceFixture('multi'),
        groups: [{ code: 'bad', label: 'Bad', optionCodes: ['missing'] }],
      },
      'choice',
    ],
  ])('preserves leaf rejection for %j', (input, branch) => {
    expect(() => validateDefinitionV2(input)).toThrow(
      new TypeError(`Expected a ${branch} definition V2`),
    );
  });

  it('rejects ambiguous aliases while accepting homonymous option labels', () => {
    const input = choiceFixture('single');
    expect(validateDefinitionV2(input)).toEqual(input);
    input.aliases = [{ label: 'Adulto', optionCode: 'a' }];
    expect(() => validateDefinitionV2(input)).toThrow(TypeError);
  });

  it('returns the exact leaf result and propagates the exact leaf TypeError', () => {
    const input = simpleFixture('text');
    const result = { ...input };
    const spy = jest.spyOn(simple, 'validateSimpleDefinitionV2');
    try {
      spy.mockReturnValueOnce(result);
      expect(validateDefinitionV2(input)).toBe(result);
      const error = new TypeError('leaf sentinel');
      spy.mockImplementationOnce(() => {
        throw error;
      });
      expect(() => validateDefinitionV2(input)).toThrow(error);
    } finally {
      spy.mockRestore();
    }
  });

  it('propagates the unsupported Unicode runtime Error unchanged', () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      process.versions,
      'unicode',
    )!;
    const capture = (run: () => unknown): unknown => {
      try {
        run();
      } catch (error) {
        return error;
      }
      throw new Error('Expected runtime rejection');
    };
    try {
      Object.defineProperty(process.versions, 'unicode', {
        ...descriptor,
        value: '16.0',
      });
      const input = choiceFixture('multi');
      const direct = capture(() => choice.validateChoiceDefinitionV2(input));
      expect(direct).toBeInstanceOf(Error);
      expect(direct).not.toBeInstanceOf(TypeError);
      const spy = jest.spyOn(choice, 'validateChoiceDefinitionV2');
      try {
        spy.mockImplementationOnce(() => {
          throw direct;
        });
        expect(capture(() => validateDefinitionV2(input))).toBe(direct);
      } finally {
        spy.mockRestore();
      }
      const dispatched = capture(() => validateDefinitionV2(input));
      expect(dispatched).toEqual(direct);
      expect(dispatched).not.toBeInstanceOf(TypeError);
    } finally {
      Object.defineProperty(process.versions, 'unicode', descriptor);
    }
  });
});
