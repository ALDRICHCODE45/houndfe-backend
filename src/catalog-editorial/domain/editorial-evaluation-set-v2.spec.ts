import { buildEditorialEvaluationSetV2 } from './editorial-evaluation-set-v2';
import type { FactInputsV2 } from './editorial-fact-rule-evaluation-v2';
import type { RuleResultV2 } from './editorial-option-case-evaluation-v2';
import type { ValueV2 } from './editorial-value-shape-v2';
import type {
  BindingV2,
  FamilyV2,
} from './editorial-vocabulary-family-shape-v2';
import type {
  BindingPolicy,
  PolicyCase,
} from './editorial-vocabulary-policy-shape-v2';

const optional: RuleResultV2 = {
  applicability: 'applicable',
  required: false,
  allowNA: false,
  evidenceRequired: false,
  documentary: 'resolved',
};
const option = (
  when: PolicyCase['when'] = [],
  code = 'selected',
): PolicyCase => ({ code, when, ...optional });
const predicate = (
  definitionCode: string,
  optionCodes = ['yes'],
): PolicyCase['when'][number] => ({
  definitionCode,
  operator: 'equals_set',
  optionCodes,
});
const policy = (...cases: PolicyCase[]): BindingPolicy => ({
  route: 'option_cases',
  cases,
});
function binding(code: string, overrides: Partial<BindingV2> = {}): BindingV2 {
  return {
    definitionId: code,
    definitionCode: code,
    owner: 'sellable',
    sortOrder: 0,
    exposure: 'INTERNAL',
    searchable: false,
    publicationCheck: 'when_asserted',
    policy: policy(option()),
    ...overrides,
  };
}
function value(
  code: string,
  variantId: string | null = 'v1',
  state: ValueV2['state'] = 'known',
  payload: Extract<ValueV2, { state: 'known' }>['payload'] = {
    type: 'single',
    value: 'yes',
  },
): ValueV2 {
  const base = { code, variantId, owner: 'sellable' as const, evidence: null };
  return state === 'known' ? { ...base, state, payload } : { ...base, state };
}
function freeze(input: unknown): void {
  if (input !== null && typeof input === 'object') {
    Object.values(input).forEach(freeze);
    Object.freeze(input);
  }
}
function run(
  bindings: BindingV2[],
  values: ValueV2[] = [],
  subjects: (string | null)[] = ['v1'],
  facts = new Map<string | null, FactInputsV2>(),
  code = 'custom',
) {
  const family: FamilyV2 = { id: code, code, label: code, bindings };
  const input = { family, values, subjects, facts: [...facts] };
  const before = structuredClone(input);
  freeze(input);
  try {
    return buildEditorialEvaluationSetV2(family, values, subjects, facts);
  } finally {
    expect({ ...input, facts: [...facts] }).toEqual(before);
  }
}
const entry = (
  code: string,
  variantId: string | null = 'v1',
  result: RuleResultV2 | null = optional,
) => ({ code, variantId, result });
const identities = (entries: ReturnType<typeof run>) =>
  entries
    .map(({ code, variantId }) => JSON.stringify([code, variantId]))
    .sort();

describe('editorial evaluation set', () => {
  it.each(['missing', 'unknown', 'not_applicable', 'known'] as const)(
    'always seeds %s assignments',
    (state) => {
      const values = state === 'missing' ? [] : [value('target', 'v1', state)];
      expect(
        run([binding('target', { publicationCheck: 'always' })], values),
      ).toEqual([entry('target')]);
    },
  );

  it.each(['missing', 'unknown', 'known', 'not_applicable'] as const)(
    'when_asserted seeds only known/NA: %s',
    (state) => {
      const values = state === 'missing' ? [] : [value('target', 'v1', state)];
      expect(run([binding('target')], values)).toEqual(
        state === 'known' || state === 'not_applicable'
          ? [entry('target')]
          : [],
      );
    },
  );

  it.each<Extract<ValueV2, { state: 'known' }>['payload']>([
    { type: 'boolean', value: false },
    { type: 'text', value: '' },
    { type: 'multi', value: [] },
    { type: 'single', value: '' },
  ])(
    'retains optional known false/empty assertion %j without readiness checks',
    (payload) => {
      expect(
        run([binding('target')], [value('target', 'v1', 'known', payload)]),
      ).toEqual([entry('target')]);
    },
  );

  it.each([
    { subjects: [] },
    { subjects: ['v1'] },
    { subjects: ['v1', 'v2', 'v1'] },
  ])('product seeds evaluate once for E=%j', ({ subjects }) => {
    const bindings = [
      binding('always', { owner: 'product', publicationCheck: 'always' }),
      binding('asserted', { owner: 'product' }),
      binding('unknown', { owner: 'product' }),
      binding('absent', { owner: 'product' }),
    ];
    const values = [
      { ...value('asserted', null), owner: 'product' as const },
      { ...value('unknown', null, 'unknown'), owner: 'product' as const },
    ];
    expect(run(bindings, values, subjects)).toEqual([
      entry('always', null),
      entry('asserted', null),
    ]);
  });

  it('includes product NA with empty E but invents no simple sellable', () => {
    expect(
      run(
        [
          binding('product', { owner: 'product' }),
          binding('simple', { publicationCheck: 'always' }),
        ],
        [{ ...value('product', null, 'not_applicable'), owner: 'product' }],
        [],
      ),
    ).toEqual([entry('product', null)]);
  });

  it('uses exact E identities, including null only if supplied, with deduplication', () => {
    const bindings = [binding('target', { publicationCheck: 'always' })];
    expect(identities(run(bindings, [], ['v2', null, 'v2']))).toEqual(
      identities([entry('target', 'v2'), entry('target', null)]),
    );
    expect(run(bindings, [value('target', 'v1')], [])).toEqual([]);
    expect(run([binding('target')], [value('target', 'v1')], ['v2'])).toEqual(
      [],
    );
  });

  it('follows selected recursive dependencies with owner/subject deduplication', () => {
    const bindings = [
      binding('target', {
        publicationCheck: 'always',
        policy: policy(option([predicate('middle')])),
      }),
      binding('middle', { policy: policy(option([predicate('product')])) }),
      binding('product', {
        owner: 'product',
        policy: policy(option([predicate('root')])),
      }),
      binding('root', { owner: 'product' }),
    ];
    const values = [
      value('middle'),
      value('middle', 'v2'),
      { ...value('product', null), owner: 'product' as const },
      { ...value('root', null), owner: 'product' as const },
    ];
    const result = run(bindings, values, ['v1', 'v2']);
    expect(identities(result)).toEqual(
      identities([
        entry('target'),
        entry('target', 'v2'),
        entry('middle'),
        entry('middle', 'v2'),
        entry('product', null),
        entry('root', null),
      ]),
    );
    expect(
      result.every(
        (item) => JSON.stringify(item.result) === JSON.stringify(optional),
      ),
    ).toBe(true);
  });

  it('does not evaluate unselected branch selectors or unrelated evidence bindings', () => {
    const bindings = [
      binding('target', {
        publicationCheck: 'always',
        policy: policy(
          option([predicate('choice')], 'yes'),
          option([predicate('choice', ['no']), predicate('other')], 'no'),
        ),
      }),
      binding('choice'),
      binding('other'),
      binding('evidence', {
        policy: policy({ ...option(), evidenceRequired: true }),
      }),
    ];
    expect(
      run(bindings, [value('choice'), value('other', 'v1', 'unknown')]),
    ).toEqual([entry('target'), entry('choice')]);
  });

  it('keeps zero/multiple selections and pending routes as unresolved entries', () => {
    const bindings = [
      binding('zero', {
        publicationCheck: 'always',
        policy: policy(option([predicate('choice')])),
      }),
      // Defensive overlap: admitted metadata normally excludes it.
      binding('multiple', {
        publicationCheck: 'always',
        policy: policy(option([], 'a'), option([], 'b')),
      }),
      binding('pending', {
        publicationCheck: 'always',
        policy: { route: 'pending' },
      }),
      binding('choice'),
    ];
    expect(run(bindings)).toEqual([
      entry('zero', 'v1', null),
      entry('multiple', 'v1', null),
      entry('pending', 'v1', null),
    ]);
  });

  it('retains selected unresolved fields instead of asserting publication readiness', () => {
    const unresolved: RuleResultV2 = {
      ...optional,
      applicability: 'unresolved',
      documentary: 'unresolved',
    };
    expect(
      run([
        binding('target', {
          publicationCheck: 'always',
          policy: policy({ ...option(), ...unresolved }),
        }),
      ]),
    ).toEqual([entry('target', 'v1', unresolved)]);
  });

  it('uses only each fact-rule subject row, never sibling or null fallback', () => {
    const animal = binding('animal.target', {
      publicationCheck: 'always',
      policy: {
        route: 'fact_rule',
        rule: {
          family: 'hygiene',
          ruleId: 'animal',
          parameter: 'animal.target',
        },
      },
    });
    const facts = new Map<string | null, FactInputsV2>([
      ['v1', { animalApplied: false }],
      ['v2', { animalApplied: true }],
      [null, { animalApplied: false }],
    ]);
    expect(
      run([animal], [], ['v1', 'v2', 'v3', null], facts, 'hygiene'),
    ).toEqual([
      entry('animal.target', 'v1', {
        applicability: 'not_applicable',
        required: false,
        allowNA: true,
        evidenceRequired: true,
        documentary: 'resolved',
      }),
      entry('animal.target', 'v2', {
        applicability: 'applicable',
        required: true,
        allowNA: false,
        evidenceRequired: true,
        documentary: 'resolved',
      }),
      entry('animal.target', 'v3', {
        applicability: 'unresolved',
        required: false,
        allowNA: false,
        evidenceRequired: true,
        documentary: 'unresolved',
      }),
      entry('animal.target', null, {
        applicability: 'not_applicable',
        required: false,
        allowNA: true,
        evidenceRequired: true,
        documentary: 'resolved',
      }),
    ]);
  });

  it('does not access facts for pending/options', () => {
    const facts = new Map<string | null, FactInputsV2>();
    const get = jest.spyOn(facts, 'get');
    expect(
      run(
        [
          binding('pending', {
            publicationCheck: 'always',
            policy: { route: 'pending' },
          }),
          binding('option', { publicationCheck: 'always' }),
        ],
        [],
        ['v1'],
        facts,
      ),
    ).toEqual([entry('pending', 'v1', null), entry('option')]);
    expect(get).not.toHaveBeenCalled();
  });

  it('evaluates repeated E identities once and ignores inactive assertions', () => {
    const facts = new Map<string | null, FactInputsV2>([
      ['v1', { animalApplied: true }],
      ['inactive', { animalApplied: false }],
    ]);
    const get = jest.spyOn(facts, 'get');
    const animal = binding('animal.target', {
      publicationCheck: 'always',
      policy: {
        route: 'fact_rule',
        rule: {
          family: 'hygiene',
          ruleId: 'animal',
          parameter: 'animal.target',
        },
      },
    });
    expect(
      run(
        [animal],
        [value('animal.target'), value('animal.target', 'inactive')],
        ['v1', 'v1'],
        facts,
        'hygiene',
      ),
    ).toHaveLength(1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('v1');
  });

  it('returns detached entries and results without changing stable inputs', () => {
    const bindings = [binding('target', { publicationCheck: 'always' })];
    const first = run(bindings),
      second = run(bindings);
    expect(first).toEqual([entry('target')]);
    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
    expect(first[0].result).not.toBe(second[0].result);
    first[0].code = 'changed';
    first[0].result!.required = true;
    expect(second).toEqual([entry('target')]);
  });

  it('preserves unexpected fact access error identity', () => {
    const sentinel = new Error('facts unavailable');
    const facts = new Map<string | null, FactInputsV2>();
    jest.spyOn(facts, 'get').mockImplementation(() => {
      throw sentinel;
    });
    const target = binding('animal.target', {
      publicationCheck: 'always',
      policy: {
        route: 'fact_rule',
        rule: {
          family: 'hygiene',
          ruleId: 'animal',
          parameter: 'animal.target',
        },
      },
    });
    let caught: unknown;
    try {
      run([target], [], ['v1'], facts, 'hygiene');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(sentinel);
  });
});
