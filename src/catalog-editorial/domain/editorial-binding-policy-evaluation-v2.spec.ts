import { evaluateBindingPolicyV2 } from './editorial-binding-policy-evaluation-v2';
import * as factEvaluation from './editorial-fact-rule-evaluation-v2';
import type { FactInputsV2 } from './editorial-fact-rule-evaluation-v2';
import * as optionEvaluation from './editorial-option-case-evaluation-v2';
import type { RuleResultV2 } from './editorial-option-case-evaluation-v2';
import type { FamilyV2 } from './editorial-vocabulary-family-shape-v2';
import type { BindingPolicy } from './editorial-vocabulary-policy-shape-v2';
import type { ValueV2 } from './editorial-value-shape-v2';

const optionPolicy: BindingPolicy = {
  route: 'option_cases',
  cases: [
    {
      code: 'selected',
      when: [],
      applicability: 'applicable',
      required: false,
      allowNA: false,
      evidenceRequired: false,
      documentary: 'not_applicable',
    },
  ],
};
const factPolicy: BindingPolicy = {
  route: 'fact_rule',
  rule: { family: 'food', ruleId: 'required', parameter: 'animal.target' },
};
const family: FamilyV2 = {
  id: 'family-id',
  code: 'food',
  label: 'Food',
  bindings: [],
};
const values: readonly ValueV2[] = [
  {
    code: 'animal.target',
    owner: 'sellable',
    variantId: 'variant-a',
    state: 'unknown',
    evidence: null,
  },
];
const facts: Readonly<FactInputsV2> = { animalApplied: true };
const selected: RuleResultV2 = {
  applicability: 'not_applicable',
  required: false,
  allowNA: true,
  evidenceRequired: false,
  documentary: 'not_applicable',
};
const unresolved: RuleResultV2 = {
  applicability: 'unresolved',
  required: false,
  allowNA: false,
  evidenceRequired: true,
  documentary: 'unresolved',
};

function unreadable<T extends object>(value: T): T {
  return new Proxy(value, {
    get() {
      throw new Error('Sibling-route input was read');
    },
    ownKeys() {
      throw new Error('Sibling-route input was enumerated');
    },
  });
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach((child: unknown) => freeze(child));
    Object.freeze(value);
  }
  return value;
}

describe('evaluateBindingPolicyV2 exclusive route dispatch (S35/S45)', () => {
  let optionSpy: jest.SpyInstance;
  let factSpy: jest.SpyInstance;

  beforeEach(() => {
    optionSpy = jest.spyOn(optionEvaluation, 'evaluateOptionCasesV2');
    factSpy = jest.spyOn(factEvaluation, 'evaluateFactRuleV2');
    optionSpy.mockReturnValue(selected);
    factSpy.mockReturnValue(selected);
  });

  afterEach(() => jest.restoreAllMocks());

  it('returns pending null without helper calls or any other input reads', () => {
    const pending = new Proxy<BindingPolicy>(
      { route: 'pending' },
      {
        get(target, key) {
          if (key === 'route') return target.route;
          throw new Error('Pending policy payload was read');
        },
        ownKeys() {
          throw new Error('Pending policy was enumerated');
        },
      },
    );
    expect(
      evaluateBindingPolicyV2(
        pending,
        unreadable(family),
        unreadable(values),
        'variant-a',
        unreadable(facts),
      ),
    ).toBeNull();
    expect(optionSpy).not.toHaveBeenCalled();
    expect(factSpy).not.toHaveBeenCalled();
  });

  it.each(['variant-a', null])(
    'passes unchanged option arguments for subject %s without reading facts',
    (subject) => {
      const result = evaluateBindingPolicyV2(
        optionPolicy,
        family,
        values,
        subject,
        unreadable(facts),
      );
      expect(result).toBe(selected);
      expect(optionSpy).toHaveBeenCalledTimes(1);
      const args = optionSpy.mock.calls[0] as unknown[];
      expect(args).toHaveLength(4);
      expect(args[0]).toBe(optionPolicy);
      expect(args[1]).toBe(family);
      expect(args[2]).toBe(values);
      expect(args[3]).toBe(subject);
      expect(factSpy).not.toHaveBeenCalled();
    },
  );

  it('passes only policy.rule and qualified facts to the fact helper', () => {
    expect(
      evaluateBindingPolicyV2(
        factPolicy,
        unreadable(family),
        unreadable(values),
        'variant-a',
        facts,
      ),
    ).toBe(selected);
    expect(factSpy).toHaveBeenCalledTimes(1);
    const args = factSpy.mock.calls[0] as unknown[];
    expect(args).toHaveLength(2);
    if (factPolicy.route !== 'fact_rule') throw new Error('Invalid fixture');
    expect(args[0]).toBe(factPolicy.rule);
    expect(args[1]).toBe(facts);
    expect(optionSpy).not.toHaveBeenCalled();
  });

  it.each([null, unresolved])(
    'preserves option unresolved result %j without fact fallback',
    (result) => {
      optionSpy.mockReturnValue(result);
      expect(
        evaluateBindingPolicyV2(optionPolicy, family, values, null, facts),
      ).toBe(result);
      expect(optionSpy).toHaveBeenCalledTimes(1);
      expect(factSpy).not.toHaveBeenCalled();
    },
  );

  it('preserves all unresolved fact fields without option fallback', () => {
    factSpy.mockReturnValue(unresolved);
    expect(
      evaluateBindingPolicyV2(factPolicy, family, values, null, facts),
    ).toBe(unresolved);
    expect(factSpy).toHaveBeenCalledTimes(1);
    expect(optionSpy).not.toHaveBeenCalled();
  });

  it.each([optionPolicy, factPolicy])(
    'propagates unexpected $route error identity without sibling fallback',
    (policy) => {
      const failure = new RangeError('Unexpected helper failure');
      const active = policy.route === 'option_cases' ? optionSpy : factSpy;
      const sibling = policy.route === 'option_cases' ? factSpy : optionSpy;
      active.mockImplementation(() => {
        throw failure;
      });
      let caught: unknown;
      try {
        evaluateBindingPolicyV2(policy, family, values, 'variant-a', facts);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(failure);
      expect(active).toHaveBeenCalledTimes(1);
      expect(sibling).not.toHaveBeenCalled();
    },
  );

  it.each([optionPolicy, factPolicy])(
    'preserves frozen $route inputs',
    (policy) => {
      const inputs = freeze({ policy, family, values, facts });
      const before = JSON.stringify(inputs);
      expect(
        evaluateBindingPolicyV2(policy, family, values, 'variant-a', facts),
      ).toBe(selected);
      expect(JSON.stringify(inputs)).toBe(before);
    },
  );
});
