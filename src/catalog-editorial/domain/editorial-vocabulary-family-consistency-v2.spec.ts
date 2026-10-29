import { assertFamilyPolicyConsistencyV2 as assertConsistency } from './editorial-vocabulary-family-consistency-v2';
import {
  type BindingV2,
  parseFamilyShapeV2,
} from './editorial-vocabulary-family-shape-v2';
import type {
  BindingPolicy,
  PolicyCase,
} from './editorial-vocabulary-policy-shape-v2';

function policyCase(overrides: Partial<PolicyCase> = {}): PolicyCase {
  return {
    code: 'case',
    when: [],
    applicability: 'applicable',
    required: false,
    allowNA: true,
    evidenceRequired: false,
    documentary: 'unresolved',
    ...overrides,
  };
}
function binding(
  code: string,
  cases: PolicyCase[] = [],
  publicationCheck: BindingV2['publicationCheck'] = 'always',
): BindingV2 {
  return {
    definitionId: `id-${code}`,
    definitionCode: code,
    owner: 'sellable',
    sortOrder: 0,
    exposure: 'INTERNAL',
    searchable: false,
    publicationCheck,
    policy: { route: 'option_cases', cases },
  };
}
function family(bindings: BindingV2[]) {
  return parseFamilyShapeV2({
    id: 'family',
    code: 'legacy',
    label: 'Legacy',
    bindings,
  });
}
function freezeTree(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  Object.values(value).forEach(freezeTree);
  Object.freeze(value);
}
const states: PolicyCase['applicability'][] = [
  'applicable',
  'not_applicable',
  'unresolved',
];
const checks: BindingV2['publicationCheck'][] = ['always', 'when_asserted'];
const error = new TypeError('Inconsistent family policy V2');

describe('assertFamilyPolicyConsistencyV2 trusted-input metadata assertion', () => {
  describe.each(checks)('%s publicationCheck', (check) => {
    it.each(states)('checks required=true with %s', (applicability) => {
      const parsed = family([
        binding(
          'target',
          [policyCase({ required: true, applicability })],
          check,
        ),
      ]);
      if (applicability === 'applicable' && check === 'always') {
        expect(assertConsistency(parsed)).toBeUndefined();
      } else {
        expect(() => assertConsistency(parsed)).toThrow(error);
      }
    });

    it.each(states)('allows optional %s with allowNA=true', (applicability) => {
      const parsed = family([
        binding('target', [policyCase({ applicability })], check),
      ]);
      const before = structuredClone(parsed);
      freezeTree(parsed);
      expect(assertConsistency(parsed)).toBeUndefined();
      expect(parsed).toEqual(before);
    });
  });

  it.each([false, true])(
    'finds a later conditional required case regardless of reversal=%s',
    (reverse) => {
      const first = binding('first', [policyCase()]);
      const later = binding(
        'later',
        [
          policyCase({ code: 'optional' }),
          policyCase({
            code: 'required',
            required: true,
            when: [
              {
                definitionCode: 'first',
                operator: 'equals_set',
                optionCodes: ['not-selected'],
              },
            ],
          }),
        ],
        'when_asserted',
      );
      if (reverse && later.policy.route === 'option_cases') {
        later.policy.cases.reverse();
      }
      const parsed = family(reverse ? [later, first] : [first, later]);
      const before = structuredClone(parsed);
      freezeTree(parsed);
      expect(() => assertConsistency(parsed)).toThrow(error);
      expect(parsed).toEqual(before);
    },
  );

  it('allows empty families and empty cases without inventing requiredness', () => {
    expect(assertConsistency(family([]))).toBeUndefined();
    expect(assertConsistency(family([binding('empty')]))).toBeUndefined();
  });

  it('leaves pending and fact_rule policies to other checks', () => {
    const policies: BindingPolicy[] = [
      { route: 'pending' },
      {
        route: 'fact_rule',
        rule: { family: 'food', ruleId: 'animal', parameter: 'toy.type' },
      },
    ];
    const parsed = family(
      policies.map((policy, index) => ({
        ...binding(`binding-${index}`, [], 'when_asserted'),
        policy,
      })),
    );
    expect(assertConsistency(parsed)).toBeUndefined();
  });

  it.each(['resolved', 'not_applicable', 'unresolved'] as const)(
    'preserves documentary=%s independently of evidenceRequired and required',
    (documentary) => {
      const parsed = family([
        binding(
          'target',
          [false, true].flatMap((required) =>
            [false, true].map((evidenceRequired) =>
              policyCase({
                code: `${required}-${evidenceRequired}`,
                documentary,
                evidenceRequired,
                required,
                allowNA: false,
              }),
            ),
          ),
        ),
      ]);
      const before = structuredClone(parsed);
      freezeTree(parsed);
      expect(assertConsistency(parsed)).toBeUndefined();
      expect(parsed).toEqual(before);
    },
  );

  it.each([false, true])(
    'allows an acyclic conditional chain, reversal=%s',
    (reverse) => {
      const bindings = ['root', 'intermediate', 'leaf'].map(
        (code, index, codes) =>
          binding(code, [
            policyCase({
              required: true,
              when:
                index === 0
                  ? []
                  : [
                      {
                        definitionCode: codes[index - 1],
                        operator: 'intersects',
                        optionCodes: ['yes'],
                      },
                    ],
            }),
          ]),
      );
      expect(
        assertConsistency(family(reverse ? bindings.reverse() : bindings)),
      ).toBeUndefined();
    },
  );
});
