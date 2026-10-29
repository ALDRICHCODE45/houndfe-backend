import { parseChoiceDefinitionShapeV2 as parse } from './editorial-vocabulary-choice-v2';

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
