import { validateDefinitionV2 } from './editorial-vocabulary-definition-v2';
import { assertFamilyPolicyConsistencyV2 } from './editorial-vocabulary-family-consistency-v2';
import { assertFamilyReferencesV2 } from './editorial-vocabulary-family-references-v2';
import { parseFamilyShapeV2 } from './editorial-vocabulary-family-shape-v2';
import { assertFamilyOptionCaseStaticV2 } from './editorial-vocabulary-option-case-static-v2';
import type {
  BindingPolicy,
  OptionTest,
  PolicyCase,
} from './editorial-vocabulary-policy-shape-v2';

const operators: OptionTest['operator'][] = [
  'equals_set',
  'contains_all',
  'intersects',
];
const inventory = ['a', 'b', 'extra'];
// Independent finite oracle: enumerate actual sets only in tests.
const subsets = Array.from({ length: 8 }, (_, mask) =>
  inventory.filter((_, index) => (mask & (1 << index)) !== 0),
);
function truth(test: OptionTest, actual: string[]): boolean {
  if (test.operator === 'equals_set') {
    return (
      actual.length === test.optionCodes.length &&
      actual.every((code) => test.optionCodes.includes(code))
    );
  }
  if (test.operator === 'contains_all') {
    return test.optionCodes.every((code) => actual.includes(code));
  }
  return actual.some((code) => test.optionCodes.includes(code));
}
function test(
  operator: OptionTest['operator'],
  optionCodes: string[],
  definitionCode = 'selector',
): OptionTest {
  return { definitionCode, operator, optionCodes };
}
function policyCase(when: OptionTest[], index = 0): PolicyCase {
  return {
    code: `case-${index}`,
    when,
    applicability: 'unresolved',
    required: false,
    allowNA: true,
    evidenceRequired: true,
    documentary: 'unresolved',
  };
}
function fixture(type: 'single' | 'multi', conditions: OptionTest[][]) {
  const definitions = ['dependent', 'selector', 'other'].map((code) =>
    validateDefinitionV2({
      id: `opaque/${code}`,
      code,
      label: code,
      type,
      options: inventory.map((code, sortOrder) => ({
        code,
        label: code,
        sortOrder,
        archived: code === 'b',
      })),
      groups: [{ code: 'group', label: 'Group', optionCodes: ['a'] }],
      aliases: [{ label: 'Alias', optionCode: 'a' }],
    }),
  );
  const family = parseFamilyShapeV2({
    id: 'custom-id',
    code: 'custom-family',
    label: 'Custom',
    bindings: definitions.map((d, sortOrder) => ({
      definitionId: d.id,
      definitionCode: d.code,
      owner: sortOrder === 1 ? 'product' : 'sellable',
      sortOrder,
      exposure: 'INTERNAL',
      searchable: false,
      publicationCheck: 'when_asserted',
      policy:
        sortOrder === 0
          ? { route: 'option_cases', cases: conditions.map(policyCase) }
          : { route: 'pending' },
    })),
  });
  const definitionsById = new Map(definitions.map((d) => [d.id, d]));
  assertFamilyReferencesV2(family, definitionsById);
  assertFamilyPolicyConsistencyV2(family);
  return { family, definitionsById };
}
function check(f: ReturnType<typeof fixture>): void {
  return assertFamilyOptionCaseStaticV2(f.family, f.definitionsById);
}
function freezeTree(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  Object.values(value).forEach(freezeTree);
  Object.freeze(value);
}

describe('assertFamilyOptionCaseStaticV2', () => {
  describe.each(['single', 'multi'] as const)('%s oracle', (type) => {
    const actuals = type === 'single' ? inventory.map((x) => [x]) : subsets;
    it.each(operators)('individual %s satisfiability', (operator) => {
      for (const expected of subsets.slice(1)) {
        const predicate = test(operator, expected);
        const f = fixture(type, [[predicate]]);
        if (actuals.some((actual) => truth(predicate, actual))) {
          expect(check(f)).toBeUndefined();
        } else {
          expect(() => check(f)).toThrow(TypeError);
        }
      }
    });
    describe.each(operators)('left %s', (left) => {
      it.each(operators)(
        'right %s: all expected sets, both orders',
        (right) => {
          for (const a of subsets.slice(1)) {
            for (const b of subsets.slice(1)) {
              const p = test(left, a);
              const q = test(right, b);
              const possible = [p, q].every((t) =>
                actuals.some((actual) => truth(t, actual)),
              );
              const overlap = actuals.some(
                (actual) => truth(p, actual) && truth(q, actual),
              );
              for (const conditions of [
                [[p], [q]],
                [[q], [p]],
              ]) {
                const f = fixture(type, conditions);
                if (!possible || overlap)
                  expect(() => check(f)).toThrow(TypeError);
                else expect(check(f)).toBeUndefined();
              }
            }
          }
        },
      );
    });
  });

  it.each(['equals_set', 'contains_all'] as const)(
    'references still accept impossible single %s; static check alone rejects',
    (operator) => {
      const f = fixture('single', [[test(operator, ['a', 'b'])]]);
      expect(() =>
        assertFamilyReferencesV2(f.family, f.definitionsById),
      ).not.toThrow();
      expect(() => check(f)).toThrow(TypeError);
    },
  );

  it('ANDs selectors: one incompatible shared selector makes cases disjoint', () => {
    const p = test('intersects', ['a', 'b']);
    const q = test('equals_set', ['a'], 'other');
    const r = test('equals_set', ['b'], 'other');
    expect(
      check(
        fixture('multi', [
          [p, q],
          [p, r],
        ]),
      ),
    ).toBeUndefined();
    expect(() =>
      check(
        fixture('multi', [
          [q, p],
          [p, q],
        ]),
      ),
    ).toThrow(TypeError);
  });

  it('different selectors coexist, including unmatched individual conditions', () => {
    const p = test('equals_set', ['a']);
    const q = test('equals_set', ['b'], 'other');
    expect(() => check(fixture('single', [[p], [q]]))).toThrow(TypeError);
    expect(() =>
      check(
        fixture('single', [[p], [test('contains_all', ['a', 'b'], 'other')]]),
      ),
    ).toThrow(TypeError);
  });

  it('allows zero cases and gaps but rejects unconditional overlap', () => {
    expect(check(fixture('single', []))).toBeUndefined();
    expect(check(fixture('single', [[]]))).toBeUndefined();
    expect(
      check(fixture('single', [[test('equals_set', ['a'])]])),
    ).toBeUndefined();
    expect(() => check(fixture('single', [[], []]))).toThrow(TypeError);
    expect(() =>
      check(fixture('single', [[], [test('intersects', ['b'])]])),
    ).toThrow(TypeError);
  });

  it.each([false, true])(
    'rejects overlap regardless of different results=%s',
    (different) => {
      const f = fixture('multi', [[], []]);
      const policy = f.family.bindings[0].policy;
      if (policy.route !== 'option_cases') throw new Error('fixture');
      if (different) policy.cases[1].documentary = 'resolved';
      expect(() => check(f)).toThrow(TypeError);
    },
  );

  it.each([false, true])(
    'frozen input is preserved on rejection=%s',
    (reject) => {
      const f = fixture(
        'single',
        reject ? [[], []] : [[test('equals_set', ['b'])]],
      );
      const before = JSON.stringify([f.family, [...f.definitionsById]]);
      freezeTree(f.family);
      for (const d of f.definitionsById.values()) freezeTree(d);
      Object.freeze(f.definitionsById);
      if (reject) expect(() => check(f)).toThrow(TypeError);
      else expect(check(f)).toBeUndefined();
      expect(JSON.stringify([f.family, [...f.definitionsById]])).toBe(before);
    },
  );

  it('keeps archived extras, mixed owners, pending roots and conditional chains', () => {
    const f = fixture('single', [[test('equals_set', ['b'])]]);
    // Product-owned intermediate selectors can depend only on product selectors.
    f.family.bindings[2].owner = 'product';
    f.family.bindings[1].policy = {
      route: 'option_cases',
      cases: [policyCase([test('intersects', ['extra'], 'other')])],
    };
    assertFamilyReferencesV2(f.family, f.definitionsById);
    assertFamilyPolicyConsistencyV2(f.family);
    expect(check(f)).toBeUndefined();
    // Every binding is checked, not only the first dependent or production names.
    f.family.bindings[1].policy.cases.push(policyCase([], 1));
    expect(() => check(f)).toThrow(TypeError);
  });

  it('checks later pairs even when the first case is disjoint', () => {
    const a = [test('equals_set', ['a'])];
    const b = [test('equals_set', ['b'])];
    expect(() => check(fixture('single', [a, b, b]))).toThrow(TypeError);
  });

  it('accepts a parsed empty family', () => {
    const f = fixture('single', []);
    f.family = parseFamilyShapeV2({ ...f.family, bindings: [] });
    expect(check(f)).toBeUndefined();
  });

  it('does not inspect result routes on non-option-case bindings', () => {
    const f = fixture('multi', []);
    const fact: BindingPolicy = {
      route: 'fact_rule',
      rule: { family: 'food', ruleId: 'animal', parameter: 'animal.target' },
    };
    f.family.bindings[1].policy = fact;
    expect(check(f)).toBeUndefined();
  });
});
