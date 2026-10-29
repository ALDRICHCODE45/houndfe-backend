import {
  parseFamilyShapeV2 as parse,
  type BindingV2,
  type FamilyV2,
} from './editorial-vocabulary-family-shape-v2';

const binding = (): BindingV2 => ({
  definitionId: ' definition-id ',
  definitionCode: ' legacy.code ',
  owner: 'product',
  sortOrder: -3,
  exposure: 'INTERNAL',
  searchable: false,
  publicationCheck: 'when_asserted',
  policy: { route: 'pending' },
});
const fixture = (): FamilyV2 => ({
  id: ' family-id ',
  code: ' custom.nonproduction ',
  label: ' Café familiar ',
  bindings: [binding()],
});
type Wire = Record<string, unknown>;
const at = (d: Wire): Wire => (d.bindings as Wire[])[0];
const error = 'Expected a family shape V2';

describe('dormant family shape V2 (not full admission)', () => {
  it('accepts exactly four family keys and empty bindings', () => {
    const input = fixture();
    expect(parse(input)).toEqual(input);
    expect(Object.keys(parse(input)).sort()).toEqual([
      'bindings',
      'code',
      'id',
      'label',
    ]);
    expect(parse({ ...input, bindings: [] }).bindings).toEqual([]);
  });

  it.each([1, 2, 3, null])(
    'rejects the obsolete family field even at %p',
    (version) => {
      expect(() =>
        parse({ ...fixture(), minimumContractVersion: version }),
      ).toThrow(error);
    },
  );

  it('accepts all binding enums, true booleans and signed safe integer orders', () => {
    for (const owner of ['product', 'sellable'] as const) {
      for (const exposure of ['INTERNAL', 'DETAIL', 'FACET'] as const) {
        for (const publicationCheck of ['always', 'when_asserted'] as const) {
          for (const sortOrder of [-3, 0, Number.MAX_SAFE_INTEGER]) {
            const input = fixture();
            input.bindings = [
              {
                ...binding(),
                owner,
                exposure,
                publicationCheck,
                sortOrder,
                searchable: true,
              },
            ];
            expect(parse(input)).toEqual(input);
          }
        }
      }
    }
  });

  it.each([
    ['family', (d: Wire) => d],
    ['binding', at],
  ] as const)('requires every key and rejects extras at %s', (_, select) => {
    for (const key of Object.keys(select(fixture()))) {
      const input = fixture();
      delete select(input)[key];
      expect(() => parse(input)).toThrow(error);
    }
    const input = fixture();
    select(input).extra = true;
    expect(() => parse(input)).toThrow(error);
  });

  it.each([
    ['family', (d: Wire) => d, 'id', ['', ' \t', 1, null]],
    ['family', (d: Wire) => d, 'code', ['', '\n', false]],
    ['family', (d: Wire) => d, 'label', ['', ' ', []]],
    ['family', (d: Wire) => d, 'bindings', [null, {}, false, [null], [[]]]],
    ['binding', at, 'definitionId', ['', ' ', 1]],
    ['binding', at, 'definitionCode', ['', '\t', null]],
    ['binding', at, 'owner', ['Product', '', 1]],
    ['binding', at, 'exposure', ['internal', '', false]],
    ['binding', at, 'searchable', ['false', 0, 1, null]],
    ['binding', at, 'publicationCheck', ['ALWAYS', '', true]],
    [
      'binding',
      at,
      'sortOrder',
      [
        0.5,
        Number.MAX_SAFE_INTEGER + 1,
        Number.MIN_SAFE_INTEGER - 1,
        '1',
        null,
      ],
    ],
  ] as const)('rejects malformed %s.%s values', (_, select, key, values) => {
    for (const value of values) {
      const input = fixture();
      select(input)[key] = value;
      expect(() => parse(input)).toThrow(error);
    }
  });

  it.each([null, [], 'family', 1, false])(
    'rejects non-record root %#',
    (input) => {
      expect(() => parse(input)).toThrow(error);
    },
  );

  it.each(['definitionId', 'definitionCode'] as const)(
    'rejects duplicate %s independently',
    (key) => {
      const input = fixture();
      input.bindings.push({
        ...binding(),
        definitionId: 'other-id',
        definitionCode: 'other-code',
        [key]: binding()[key],
      });
      expect(() => parse(input)).toThrow(error);
    },
  );

  it('composes policy branches without contextual reference or production triple admission', () => {
    const input = fixture();
    input.bindings.push({
      ...binding(),
      definitionId: 'unresolved-id',
      definitionCode: 'unresolved-code',
      policy: {
        route: 'fact_rule',
        rule: { family: 'care', ruleId: 'required', parameter: 'toy.type' },
      },
    });
    expect(parse(input)).toEqual(input);
    input.bindings[0].policy = { route: 'option_cases', cases: [] };
    expect(parse(input)).toEqual(input);
  });

  it.each([
    null,
    { route: 'pending', extra: true },
    { route: 'option_cases', cases: [{ code: 'incomplete' }] },
  ])('propagates invalid child policy errors %#', (policy) => {
    const input = fixture();
    at(input).policy = policy;
    expect(() => parse(input)).toThrow('Expected a binding policy shape V2');
  });

  it('detaches every container, preserves spelling/order and accepts frozen input', () => {
    const input = fixture();
    input.bindings[0].policy = {
      route: 'option_cases',
      cases: [
        {
          code: ' z ',
          when: [
            {
              definitionCode: ' unresolved ',
              operator: 'equals_set',
              optionCodes: ['z', ' A '],
            },
          ],
          applicability: 'applicable',
          required: true,
          allowNA: true,
          evidenceRequired: false,
          documentary: 'unresolved',
        },
      ],
    };
    input.bindings.push({
      ...binding(),
      definitionId: 'a',
      definitionCode: 'a',
      sortOrder: -10,
      policy: {
        route: 'fact_rule',
        rule: {
          family: 'food',
          ruleId: 'required',
          parameter: 'animal.target',
        },
      },
    });
    input.bindings.push({
      ...binding(),
      definitionId: 'b',
      definitionCode: 'b',
    });
    const freeze = (value: unknown): void => {
      if (value && typeof value === 'object') {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
      }
    };
    freeze(input);
    const output = parse(input);
    expect(output).toEqual(input);
    const detached = (source: unknown, result: unknown): void => {
      if (source && typeof source === 'object') {
        expect(result).not.toBe(source);
        for (const key of Object.keys(source)) {
          detached((source as Wire)[key], (result as Wire)[key]);
        }
      }
    };
    detached(input, output);
    output.bindings[0].definitionCode = 'changed';
    output.bindings.reverse();
    expect(input.bindings[0].definitionCode).toBe(' legacy.code ');
    expect(input.bindings[0].sortOrder).toBe(-3);
  });

  it.each(['root', 'binding', 'policy'])(
    'rejects %s accessors without invocation',
    (level) => {
      const input = fixture();
      const target =
        level === 'root'
          ? input
          : level === 'binding'
            ? input.bindings[0]
            : input.bindings[0].policy;
      const key =
        level === 'root' ? 'bindings' : level === 'binding' ? 'owner' : 'route';
      const getter = jest.fn(() => {
        throw new Error('must not invoke');
      });
      Object.defineProperty(target, key, { enumerable: true, get: getter });
      expect(() => parse(input)).toThrow(error);
      expect(getter).not.toHaveBeenCalled();
    },
  );

  it('uses the canonical guard for malformed trees', () => {
    const cycle: Wire = fixture();
    cycle.self = cycle;
    const sparse = fixture();
    sparse.bindings = new Array<BindingV2>(1);
    for (const input of [
      cycle,
      sparse,
      ...[undefined, NaN, Infinity, '\ud800', new Date(), 1n].map((extra) => ({
        ...fixture(),
        extra,
      })),
    ]) {
      expect(() => parse(input)).toThrow(error);
    }
  });
});
