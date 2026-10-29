import {
  parseChoiceDefinitionShapeV2 as parse,
  validateChoiceDefinitionV2 as validate,
} from './editorial-vocabulary-choice-v2';
import { editorialAliasComparisonKeyV1 } from './editorial-alias-comparison-v1';

const option = (code = 'a', label = 'Café') => ({
  code,
  label,
  archived: true,
  sortOrder: -1,
});
const fixture = (type: 'single' | 'multi') => ({
  id: ' id ',
  code: 'choice',
  label: ' Elección ',
  type,
  options: [option('b', 'Otro'), option()],
  groups: [{ code: 'g', label: 'Grupo', optionCodes: ['a', 'b'] }],
  aliases: [{ label: 'CAFE', optionCode: 'a' }],
});

// Mutations describe malformed wire data, not the statically typed output.
type Wire = Record<string, unknown>;
const first = (d: Wire, key: string): Wire => (d[key] as Wire[])[0];
describe.each(['single', 'multi'] as const)(
  'dormant %s choice metadata',
  (type) => {
    it.each([false, true])(
      'accepts populated/empty metadata (empty=%s)',
      (empty) => {
        const input = fixture(type);
        if (empty)
          Object.assign(input, { options: [], groups: [], aliases: [] });
        input.options.forEach((o) => (o.sortOrder = Number.MAX_SAFE_INTEGER));
        expect(parse(input)).toEqual(input);
      },
    );

    const levels = [
      ['root', (d: Wire) => d],
      ['option', (d: Wire) => first(d, 'options')],
      ['group', (d: Wire) => first(d, 'groups')],
      ['alias', (d: Wire) => first(d, 'aliases')],
    ] as const;
    it.each(levels)(
      'rejects every missing/extra key at %s',
      (_name, select) => {
        for (const key of Object.keys(select(fixture(type)))) {
          const input = fixture(type);
          delete select(input)[key];
          expect(() => parse(input)).toThrow('Expected a choice definition V2');
        }
        const input = fixture(type);
        select(input).extra = true;
        expect(() => parse(input)).toThrow(TypeError);
      },
    );

    it.each([
      [
        'root identity',
        (d: Wire) => {
          d.id = 3;
        },
      ],
      [
        'type',
        (d: Wire) => {
          d.type = 'text';
        },
      ],
      [
        'options',
        (d: Wire) => {
          d.options = {};
        },
      ],
      [
        'groups',
        (d: Wire) => {
          d.groups = null;
        },
      ],
      [
        'aliases',
        (d: Wire) => {
          d.aliases = 'alias';
        },
      ],
      [
        'option record',
        (d: Wire) => {
          (d.options as unknown[])[0] = null;
        },
      ],
      [
        'group record',
        (d: Wire) => {
          (d.groups as unknown[])[0] = [];
        },
      ],
      [
        'alias record',
        (d: Wire) => {
          (d.aliases as unknown[])[0] = false;
        },
      ],
      [
        'archive',
        (d: Wire) => {
          first(d, 'options').archived = 1;
        },
      ],
      [
        'fraction',
        (d: Wire) => {
          first(d, 'options').sortOrder = 0.5;
        },
      ],
      [
        'unsafe',
        (d: Wire) => {
          first(d, 'options').sortOrder = 2 ** 53;
        },
      ],
      [
        'sort string',
        (d: Wire) => {
          first(d, 'options').sortOrder = '1';
        },
      ],
      [
        'members',
        (d: Wire) => {
          first(d, 'groups').optionCodes = null;
        },
      ],
      [
        'member type',
        (d: Wire) => {
          first(d, 'groups').optionCodes = [1];
        },
      ],
      [
        'alias target type',
        (d: Wire) => {
          first(d, 'aliases').optionCode = 1;
        },
      ],
      [
        'duplicate option',
        (d: Wire) => {
          (d.options as unknown[]).push(option());
        },
      ],
      [
        'duplicate group',
        (d: Wire) => {
          (d.groups as unknown[]).push(first(d, 'groups'));
        },
      ],
      [
        'duplicate member',
        (d: Wire) => {
          first(d, 'groups').optionCodes = ['a', 'a'];
        },
      ],
      [
        'dangling member',
        (d: Wire) => {
          first(d, 'groups').optionCodes = ['A'];
        },
      ],
      [
        'dangling target',
        (d: Wire) => {
          first(d, 'aliases').optionCode = 'A';
        },
      ],
    ] as const)('rejects %s', (_name, mutate) => {
      const input = fixture(type);
      mutate(input);
      expect(() => parse(input)).toThrow(TypeError);
    });

    it.each(levels)('rejects blank/non-string text at %s', (_name, select) => {
      for (const [key, value] of Object.entries(select(fixture(type)))) {
        if (typeof value !== 'string' || key === 'type') continue;
        for (const bad of [' \t\n', 42]) {
          const input = fixture(type);
          select(input)[key] = bad;
          expect(() => parse(input)).toThrow(TypeError);
        }
      }
    });

    it('preserves frozen input and detaches every nested container', () => {
      const input = fixture(type);
      input.groups.push({ code: 'other', label: 'CAFE', optionCodes: ['a'] });
      const freeze = (v: unknown) => {
        if (v && typeof v === 'object') {
          Object.values(v).forEach(freeze);
          Object.freeze(v);
        }
      };
      freeze(input);
      const output = parse(input);
      expect(output).toEqual(input);
      expect(output).not.toBe(input);
      for (const key of ['options', 'groups', 'aliases'] as const) {
        expect(output[key]).not.toBe(input[key]);
        output[key].forEach((entry: unknown, i: number) =>
          expect(entry).not.toBe(input[key][i]),
        );
      }
      expect(output.groups[0].optionCodes).not.toBe(
        input.groups[0].optionCodes,
      );
      output.groups[0].optionCodes.reverse();
      output.options[0].label = 'changed';
      expect(input.options[0].label).toBe('Otro');
      expect(input.groups[0].optionCodes).toEqual(['a', 'b']);
    });
  },
);

it.each([null, [], 1, undefined])('rejects non-object root %p', (input) => {
  expect(() => parse(input)).toThrow(TypeError);
});
it('guards accessors before reading properties', () => {
  const getter = jest.fn(() => 'single');
  const input = fixture('single');
  Object.defineProperty(input, 'type', { get: getter, enumerable: true });
  expect(() => parse(input)).toThrow(TypeError);
  expect(getter).not.toHaveBeenCalled();
});
it.each(['cycle', 'surrogate', 'nonfinite'])(
  'delegates %s rejection to canonical guard',
  (kind) => {
    const input: Wire = fixture('multi');
    if (kind === 'cycle') input.options = input;
    if (kind === 'surrogate') input.label = '\ud800';
    if (kind === 'nonfinite') first(input, 'options').sortOrder = Infinity;
    expect(() => parse(input)).toThrow(TypeError);
  },
);

describe.each(['single', 'multi'] as const)(
  '%s choice namespace admission',
  (type) => {
    it('delegates shape checks and returns the same detached metadata as C1', () => {
      const input = fixture(type);
      expect(validate(input)).toEqual(parse(input));
      const output = validate(input);
      expect(output).not.toBe(input);
      expect(output.options[0]).not.toBe(input.options[0]);
      expect(output.groups[0].optionCodes).not.toBe(
        input.groups[0].optionCodes,
      );
      expect(output.aliases[0]).not.toBe(input.aliases[0]);
      expect(() => validate({ ...input, extra: true })).toThrow(
        new TypeError('Expected a choice definition V2'),
      );
    });

    it.each(['a', 'b'])(
      'permits homonyms but rejects alias to %s',
      (target) => {
        const input = fixture(type);
        input.options = [option('a', 'Adulto'), option('b', 'Adulto')];
        input.aliases = [];
        expect(validate(input)).toEqual(input);
        input.aliases = [{ label: 'ADULTO', optionCode: target }];
        expect(() => validate(input)).toThrow(TypeError);
      },
    );

    it.each(['code', 'label', 'alias'] as const)(
      'blocks other-target %s collisions in either order',
      (source) => {
        const input = fixture(type);
        input.aliases = [{ label: 'conflict', optionCode: 'a' }];
        if (source === 'alias')
          input.aliases.push({ label: 'CONFLICT', optionCode: 'b' });
        else input.options[0][source] = 'CONFLICT';
        input.groups = [];
        expect(() => validate(input)).toThrow(TypeError);
        input.options.reverse();
        input.aliases.reverse();
        expect(() => validate(input)).toThrow(TypeError);
      },
    );

    it('allows equivalent same-target spellings, not exact duplicate aliases', () => {
      const input = fixture(type);
      input.aliases = ['café', 'CAFE'].map((label) => ({
        label,
        optionCode: 'a',
      }));
      expect(validate(input)).toEqual(input);
      input.aliases.reverse();
      expect(validate(input)).toEqual(input);
      input.aliases.push({ label: 'café', optionCode: 'a' });
      expect(() => validate(input)).toThrow(TypeError);
    });

    it('applies ordinary collision rules to empty comparison keys', () => {
      const input = fixture(type);
      input.aliases = [{ label: '\u0301', optionCode: 'a' }];
      expect(validate(input)).toEqual(input);
      input.options[0].label = '\u0300';
      expect(() => validate(input)).toThrow(TypeError);
    });

    it('excludes group labels and codes from the namespace', () => {
      const input = fixture(type);
      input.groups[0].label = 'CAFE';
      input.groups[0].code = 'café';
      expect(validate(input)).toEqual(input);
    });

    it('propagates the unsupported Unicode runtime error unchanged', () => {
      const descriptor = Object.getOwnPropertyDescriptor(
        process.versions,
        'unicode',
      )!;
      try {
        Object.defineProperty(process.versions, 'unicode', {
          ...descriptor,
          value: '16.0',
        });
        let expected: unknown;
        try {
          editorialAliasComparisonKeyV1('CAFE');
        } catch (error) {
          expected = error;
        }
        expect(expected).toBeInstanceOf(Error);
        expect(() => validate(fixture(type))).toThrow(expected as Error);
        expect(() => validate(fixture(type))).not.toThrow(TypeError);
      } finally {
        Object.defineProperty(process.versions, 'unicode', descriptor);
      }
    });
  },
);
