import { assertEditorialEvaluationReadinessV2 as admit } from './editorial-evaluation-readiness-v2';
import * as builder from './editorial-evaluation-set-v2';
import * as readiness from './editorial-selected-binding-readiness-v2';
import type { FactInputsV2 } from './editorial-fact-rule-evaluation-v2';
import type { ValueV2 } from './editorial-value-shape-v2';
import type {
  BindingV2,
  FamilyV2,
} from './editorial-vocabulary-family-shape-v2';

function binding(
  code = 'target',
  overrides: Partial<BindingV2> = {},
): BindingV2 {
  return {
    definitionId: `id/${code}`,
    definitionCode: code,
    owner: 'sellable',
    sortOrder: 0,
    exposure: 'INTERNAL',
    searchable: false,
    publicationCheck: 'always',
    policy: {
      route: 'option_cases',
      cases: [
        {
          code: 'selected',
          when: [],
          applicability: 'applicable',
          required: true,
          allowNA: false,
          evidenceRequired: true,
          documentary: 'resolved',
        },
      ],
    },
    ...overrides,
  };
}
function family(...bindings: BindingV2[]): FamilyV2 {
  return { id: 'custom', code: 'custom', label: 'Custom', bindings };
}
function value(code = 'target', variantId: string | null = 'a'): ValueV2 {
  return {
    code,
    variantId,
    owner: 'sellable',
    state: 'known',
    payload: { type: 'single', value: 'yes' },
    evidence: { sourceRef: 'manufacturer', verifiedOn: '2024-02-29' },
  };
}
const noFacts = new Map<string | null, FactInputsV2>();
afterEach(() => jest.restoreAllMocks());

it('builds once and forwards each exact result and matching value', () => {
  const f = family(binding('first'), binding('second'));
  const values = [
    value('second', 'b'),
    value('first', 'a'),
    value('first', 'b'),
    value('second', 'a'),
  ];
  const subjects = ['a', 'b'];
  const build = jest.spyOn(builder, 'buildEditorialEvaluationSetV2');
  const consume = jest.spyOn(readiness, 'selectedBindingProblemV2');
  expect(admit(f, values, subjects, noFacts)).toBeUndefined();
  expect(build).toHaveBeenCalledTimes(1);
  expect(build.mock.calls[0]).toEqual([f, values, subjects, noFacts]);
  const entries = build.mock.results[0].value as builder.EvaluationEntryV2[];
  expect(consume).toHaveBeenCalledTimes(4);
  entries.forEach((entry, i) => {
    expect(consume.mock.calls[i][0]).toBe(entry.result);
    expect(consume.mock.calls[i][1]).toBe(
      values.find(
        (v) => v.code === entry.code && v.variantId === entry.variantId,
      ),
    );
  });
});

it.each(['wrong-code', 'sibling', 'later-subject'])(
  'cannot substitute %s for a missing required assignment',
  (scenario) => {
    const values =
      scenario === 'wrong-code' ? [value('other')] : [value('target', 'a')];
    const subjects =
      scenario === 'wrong-code'
        ? ['a']
        : scenario === 'sibling'
          ? ['b']
          : ['a', 'b'];
    const f = family(
      binding(),
      ...(scenario === 'wrong-code' ? [binding('other')] : []),
    );
    expect(() => admit(f, values, subjects, noFacts)).toThrow(/^MALFORMED$/);
  },
);

it.each(['missing', 'unknown', 'empty', 'no-evidence', 'bad-evidence', 'na'])(
  'consumes local readiness rejection: %s',
  (state) => {
    const row = value();
    if (row.state !== 'known') throw new Error('Expected known fixture');
    let values: ValueV2[] = [row];
    if (state === 'missing') values = [];
    if (state === 'unknown' || state === 'na')
      values = [
        {
          code: row.code,
          owner: row.owner,
          variantId: row.variantId,
          state: state === 'na' ? 'not_applicable' : 'unknown',
          evidence: null,
        },
      ];
    if (state === 'empty') row.payload = { type: 'single', value: '' };
    if (state === 'no-evidence') row.evidence = null;
    if (state === 'bad-evidence')
      row.evidence = { sourceRef: '', verifiedOn: 'invalid' };
    expect(() => admit(family(binding()), values, ['a'], noFacts)).toThrow(
      /^MALFORMED$/,
    );
  },
);

it('consumes unresolved selection even without a supplied value', () => {
  expect(() =>
    admit(
      family(binding('target', { policy: { route: 'pending' } })),
      [],
      ['a'],
      noFacts,
    ),
  ).toThrow(/^MALFORMED$/);
});

it('limits local completeness to supplied E without waiving other fresh gates', () => {
  const invalid = { ...value('target', 'inactive'), evidence: null };
  expect(
    admit(family(binding()), [invalid, value()], ['a'], noFacts),
  ).toBeUndefined();
  expect(() =>
    admit(family(binding()), [invalid, value()], ['a', 'inactive'], noFacts),
  ).toThrow(/^MALFORMED$/);
});

it('checks product bindings once even for empty E, without generating sellable subjects', () => {
  const f = family(binding('product', { owner: 'product' }), binding());
  expect(() => admit(f, [], [], noFacts)).toThrow(/^MALFORMED$/);
  const row = { ...value('product', null), owner: 'product' as const };
  const consume = jest.spyOn(readiness, 'selectedBindingProblemV2');
  expect(admit(f, [row], [], noFacts)).toBeUndefined();
  expect(consume).toHaveBeenCalledTimes(1);
  expect(consume.mock.calls[0][1]).toBe(row);
});

it('preserves exact-subject fact resolution rather than borrowing a sibling', () => {
  const f = family(
    binding('animal.target', {
      policy: {
        route: 'fact_rule',
        rule: {
          family: 'hygiene',
          ruleId: 'animal',
          parameter: 'animal.target',
        },
      },
    }),
  );
  f.code = 'hygiene';
  const facts = new Map<string | null, FactInputsV2>([
    ['a', { animalApplied: false }],
  ]);
  expect(admit(f, [], ['a'], facts)).toBeUndefined();
  expect(() => admit(f, [], ['a', 'b'], facts)).toThrow(/^MALFORMED$/);
});

it('admits selected NA but rejects a known value against the same negative result', () => {
  const b = binding();
  b.policy = {
    route: 'option_cases',
    cases: [
      {
        code: 'negative',
        when: [],
        applicability: 'not_applicable',
        required: false,
        allowNA: true,
        evidenceRequired: true,
        documentary: 'resolved',
      },
    ],
  };
  const na: ValueV2 = {
    code: 'target',
    owner: 'sellable',
    variantId: 'a',
    state: 'not_applicable',
    evidence: null,
  };
  expect(admit(family(b), [na], ['a'], noFacts)).toBeUndefined();
  expect(() => admit(family(b), [value()], ['a'], noFacts)).toThrow(
    /^MALFORMED$/,
  );
});

it.each(['builder', 'consumer'])(
  'preserves unexpected %s error identity',
  (origin) => {
    const error = new Error('unexpected');
    if (origin === 'builder')
      jest
        .spyOn(builder, 'buildEditorialEvaluationSetV2')
        .mockImplementation(() => {
          throw error;
        });
    else
      jest
        .spyOn(readiness, 'selectedBindingProblemV2')
        .mockImplementation(() => {
          throw error;
        });
    let caught: unknown;
    try {
      admit(family(binding()), [value()], ['a'], noFacts);
    } catch (failure) {
      caught = failure;
    }
    expect(caught).toBe(error);
  },
);

it('preserves frozen inputs on successful and failed evaluation', () => {
  const f = family(binding());
  const values = [value()];
  const subjects = ['a'];
  function freeze(input: unknown): void {
    if (input && typeof input === 'object') {
      Object.values(input).forEach(freeze);
      Object.freeze(input);
    }
  }
  const inputs = { f, values, subjects, facts: [...noFacts] };
  const before = structuredClone(inputs);
  freeze(inputs);
  expect(admit(f, values, subjects, noFacts)).toBeUndefined();
  expect(() => admit(f, values, ['b'], noFacts)).toThrow(/^MALFORMED$/);
  expect({ f, values, subjects, facts: [...noFacts] }).toEqual(before);
});
