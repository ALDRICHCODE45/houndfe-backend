import {
  evaluateOptionCasesV2,
  selectOptionCaseV2,
  type RuleResultV2,
} from './editorial-option-case-evaluation-v2';
import type {
  BindingV2,
  FamilyV2,
} from './editorial-vocabulary-family-shape-v2';
import type {
  BindingPolicy,
  OptionTest,
  PolicyCase,
} from './editorial-vocabulary-policy-shape-v2';
import type { ValueV2 } from './editorial-value-shape-v2';

const result: RuleResultV2 = {
  applicability: 'applicable',
  required: true,
  allowNA: false,
  evidenceRequired: true,
  documentary: 'resolved',
};
const test = (
  operator: OptionTest['operator'] = 'equals_set',
  optionCodes = ['a'],
  definitionCode = 'choice',
): OptionTest => ({ definitionCode, operator, optionCodes });
const rule = (when: OptionTest[] = [test()], code = 'case'): PolicyCase => ({
  code,
  when,
  ...result,
});
function known(
  codes: string[],
  type: 'single' | 'multi' = 'multi',
  variantId: string | null = 'v1',
  code = 'choice',
): ValueV2 {
  return {
    code,
    owner: code === 'product' ? 'product' : 'sellable',
    variantId,
    state: 'known',
    payload:
      type === 'single' ? { type, value: codes[0] } : { type, value: codes },
    evidence: null,
  };
}
function family(policy: BindingPolicy): FamilyV2 {
  const binding = (code: string, owner: BindingV2['owner']): BindingV2 => ({
    definitionId: code,
    definitionCode: code,
    owner,
    sortOrder: 0,
    exposure: 'INTERNAL',
    searchable: false,
    publicationCheck: 'always',
    policy: { route: 'pending' },
  });
  return {
    id: 'custom',
    code: 'custom',
    label: 'Custom',
    bindings: [
      binding('choice', 'sellable'),
      binding('product', 'product'),
      { ...binding('target', 'sellable'), policy },
    ],
  };
}
function freeze(input: unknown): void {
  if (input !== null && typeof input === 'object') {
    Object.values(input).forEach(freeze);
    Object.freeze(input);
  }
}
function select(
  cases: PolicyCase[],
  values: ValueV2[] = [],
  subject: string | null = 'v1',
) {
  const policy = { route: 'option_cases' as const, cases };
  const input = { policy, family: family(policy), values };
  const before = structuredClone(input);
  freeze(input);
  try {
    return evaluateOptionCasesV2(policy, input.family, values, subject);
  } finally {
    expect(input).toEqual(before);
  }
}

describe('selected option-case identity', () => {
  function identify(
    cases: PolicyCase[],
    values: ValueV2[] = [],
    subject: string | null = 'v1',
  ) {
    const policy = { route: 'option_cases' as const, cases };
    const input = { policy, family: family(policy), values };
    const before = structuredClone(input);
    freeze(input);
    try {
      const selection = selectOptionCaseV2(
        policy,
        input.family,
        values,
        subject,
      );
      expect(
        evaluateOptionCasesV2(policy, input.family, values, subject),
      ).toEqual(selection?.result ?? null);
      return selection;
    } finally {
      expect(input).toEqual(before);
    }
  }

  it('distinguishes disjoint cases with identical results and own dependencies', () => {
    const cases = [
      rule(
        [test('equals_set', ['b']), test('equals_set', ['p'], 'product')],
        'unselected',
      ),
      rule([test()], 'selected'),
    ];
    const actual = identify(cases, [known(['a'])]);
    expect(actual).toEqual({ caseCode: 'selected', result });
    expect(cases.find((item) => item.code === actual!.caseCode)?.when).toEqual([
      test(),
    ]);
  });

  it.each([
    { cases: [] },
    { cases: [rule()] },
    { cases: [rule([], 'first'), rule([], 'second')] },
  ])('has no identity for zero or multiple matches: %j', ({ cases }) =>
    expect(identify(cases)).toBeNull(),
  );

  it('preserves unresolved fields on a selected unconditional case', () => {
    const unresolved: RuleResultV2 = {
      ...result,
      applicability: 'unresolved',
      required: false,
      documentary: 'unresolved',
    };
    expect(identify([{ ...rule([], 'unconditional'), ...unresolved }])).toEqual(
      {
        caseCode: 'unconditional',
        result: unresolved,
      },
    );
  });

  it.each(['equals_set', 'contains_all', 'intersects'] as const)(
    '%s retains identity and single/multi matching behavior',
    (operator) => {
      for (const type of ['single', 'multi'] as const) {
        expect(
          identify([rule([test(operator)])], [known(['a'], type)]),
        ).toEqual({
          caseCode: 'case',
          result,
        });
        expect(
          identify([rule([test(operator)])], [known(['b'], type)]),
        ).toBeNull();
      }
    },
  );

  it('keeps product selectors at null and sellable selectors on the subject', () => {
    const cases = [rule([test(), test('equals_set', ['p'], 'product')])];
    const product = known(['p'], 'single', null, 'product');
    const values = [known(['a'], 'single', 'v2'), product];
    expect(identify(cases, values)).toBeNull();
    expect(identify(cases, values, 'v2')).toEqual({ caseCode: 'case', result });
    expect(
      identify(cases, [known(['a'], 'single', null), product], null),
    ).toEqual({
      caseCode: 'case',
      result,
    });
    expect(
      identify(cases, [known(['a']), { ...product, variantId: 'v1' }]),
    ).toBeNull();
  });

  it.each(['unknown', 'not_applicable'] as const)(
    '%s does not acquire an identity',
    (state) => {
      const value: ValueV2 = {
        code: 'choice',
        owner: 'sellable',
        variantId: 'v1',
        state,
        evidence: null,
      };
      expect(identify([rule()], [value])).toBeNull();
    },
  );

  it('returns fresh detached identity and result without widening the old API', () => {
    const candidate = rule([], 'original');
    const first = identify([candidate])!;
    const second = identify([candidate])!;
    expect(first).toEqual({ caseCode: 'original', result });
    expect(first).not.toBe(second);
    expect(first.result).not.toBe(second.result);
    first.caseCode = 'changed';
    first.result.required = false;
    expect(second).toEqual({ caseCode: 'original', result });
    expect(candidate).toEqual(rule([], 'original'));
    expect(select([candidate])).toEqual(result);
  });

  it.each([evaluateOptionCasesV2, selectOptionCaseV2])(
    'preserves encountered input errors through %p',
    (evaluate) => {
      const invalid: ValueV2 = {
        ...known(['a']),
        state: 'known',
        payload: { type: 'text', value: 'a' },
        evidence: null,
      };
      const policy = { route: 'option_cases' as const, cases: [rule()] };
      expect(() => evaluate(policy, family(policy), [invalid], 'v1')).toThrow(
        new TypeError('Expected admitted option-case inputs'),
      );
      const unbound = {
        route: 'option_cases' as const,
        cases: [rule([test('equals_set', ['a'], 'unbound')])],
      };
      expect(() => evaluate(unbound, family(unbound), [], 'v1')).toThrow(
        new TypeError('Expected admitted option-case inputs'),
      );
    },
  );

  it.each([evaluateOptionCasesV2, selectOptionCaseV2])(
    'preserves unexpected error identity through %p',
    (evaluate) => {
      const policy = { route: 'option_cases' as const, cases: [rule()] };
      const metadata = family(policy);
      const sentinel = new Error('metadata access failed');
      Object.defineProperty(metadata, 'bindings', {
        get() {
          throw sentinel;
        },
      });
      let caught: unknown;
      try {
        evaluate(policy, metadata, [], 'v1');
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(sentinel);
    },
  );
});

describe('runtime option-case selection', () => {
  it.each<['equals_set' | 'contains_all' | 'intersects', string[], boolean]>([
    ['equals_set', ['b', 'a'], true],
    ['equals_set', ['a', 'b', 'c'], false],
    ['equals_set', ['a'], false],
    ['equals_set', [], false],
    ['equals_set', ['c'], false],
    ['contains_all', ['b', 'a'], true],
    ['contains_all', ['a', 'b', 'c'], true],
    ['contains_all', ['a'], false],
    ['contains_all', [], false],
    ['contains_all', ['c'], false],
    ['intersects', ['b', 'a'], true],
    ['intersects', ['a', 'b', 'c'], true],
    ['intersects', ['a'], true],
    ['intersects', [], false],
    ['intersects', ['c'], false],
  ])('%s on exact multi set %j matches=%s', (operator, actual, matches) => {
    expect(
      select([rule([test(operator, ['a', 'b'])])], [known(actual)]),
    ).toEqual(matches ? result : null);
  });

  it.each(['equals_set', 'contains_all', 'intersects'] as const)(
    '%s treats known single as a singleton without evidence',
    (operator) => {
      const cases = [rule([test(operator)])];
      expect(select(cases, [known(['a'], 'single')])).toEqual(result);
      expect(select(cases, [known(['b'], 'single')])).toBeNull();
    },
  );

  it('ANDs selectors and reads a product selector at null', () => {
    const cases = [rule([test(), test('equals_set', ['p'], 'product')])];
    const values = [known(['a']), known(['p'], 'single', null, 'product')];
    expect(select(cases, values)).toEqual(result);
    expect(select(cases, [values[0]])).toBeNull();
    expect(select(cases, [values[1]])).toBeNull();
  });

  it('accepts an empty when unconditionally, but no cases stays unresolved', () => {
    expect(select([rule([])])).toEqual(result);
    expect(select([])).toBeNull();
  });

  it('selects a unique later case rather than the first or last case', () => {
    const later = { ...rule([test()], 'later'), required: false };
    expect(
      select(
        [
          rule([test('equals_set', ['b'])]),
          later,
          rule([test('equals_set', ['c'])], 'last'),
        ],
        [known(['a'])],
      ),
    ).toEqual({ ...result, required: false });
  });

  it.each([false, true])(
    'fails closed on multiple matches, equal results=%s',
    (equal) => {
      // Defensive overlap: admitted static metadata normally excludes this input.
      const second = { ...rule([], 'second'), required: equal };
      expect(select([rule([]), second])).toBeNull();
    },
  );

  it.each(['missing', 'unknown', 'not_applicable'] as const)(
    '%s selector never matches',
    (state) => {
      const values: ValueV2[] =
        state === 'missing'
          ? []
          : [
              {
                code: 'choice',
                owner: 'sellable',
                variantId: 'v1',
                state,
                evidence: null,
              },
            ];
      expect(select([rule()], values)).toBeNull();
    },
  );

  it('reads only the selected sellable, never its sibling', () => {
    const values = [known(['a'], 'single', 'v2'), known(['b'], 'single', 'v1')];
    expect(select([rule()], values)).toBeNull();
    expect(select([rule()], values, 'v2')).toEqual(result);
    expect(select([rule()], [values[0]])).toBeNull();
  });

  it('supports the null identity of a simple sellable', () => {
    expect(select([rule()], [known(['a'], 'single', null)], null)).toEqual(
      result,
    );
    expect(select([rule()], [known(['a'], 'single', null)])).toBeNull();
  });

  it.each(['A', ' a ', 'alias-a', 'group-a', 'á'])(
    'does not normalize or interpret option identity %s',
    (code) => expect(select([rule()], [known([code])])).toBeNull(),
  );

  it('does not turn a known non-choice payload into a nonmatch', () => {
    const invalid: ValueV2 = {
      ...known(['a']),
      state: 'known',
      payload: { type: 'text', value: 'a' },
      evidence: null,
    };
    expect(() => select([rule()], [invalid])).toThrow(
      new TypeError('Expected admitted option-case inputs'),
    );
  });

  it('does not turn an unbound selector into a nonmatch', () => {
    expect(() =>
      select([rule([test('equals_set', ['a'], 'unbound')])]),
    ).toThrow(new TypeError('Expected admitted option-case inputs'));
  });

  it.each<RuleResultV2>([
    result,
    {
      applicability: 'not_applicable',
      required: false,
      allowNA: true,
      evidenceRequired: false,
      documentary: 'not_applicable',
    },
    {
      applicability: 'unresolved',
      required: false,
      allowNA: false,
      evidenceRequired: true,
      documentary: 'unresolved',
    },
  ])('returns only five detached result fields: %j', (expected) => {
    const selected = { ...rule([]), ...expected };
    const actual = select([selected]);
    expect(actual).toEqual(expected);
    expect(actual).not.toBe(selected);
    actual!.required = !actual!.required;
    expect(selected.required).toBe(expected.required);
  });
});
