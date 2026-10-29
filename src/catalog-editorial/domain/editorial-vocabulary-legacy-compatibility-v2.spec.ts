import { validateVocabularyConsistencyV2 } from './editorial-vocabulary-consistency-v2';
import type { DefinitionV2 } from './editorial-vocabulary-definition-v2';
import type { BindingV2 } from './editorial-vocabulary-family-shape-v2';
import { assertFamilyLegacyCompatibilityV2 as assertLegacy } from './editorial-vocabulary-legacy-compatibility-v2';
import type { NumericPolicyV2 } from './editorial-vocabulary-numeric-v2';
import type {
  BindingPolicy,
  PolicyCase,
} from './editorial-vocabulary-policy-shape-v2';
import type { VocabularyV2 } from './editorial-vocabulary-shape-v2';

const errorMessage = 'Expected a legacy-compatible family V2';
function fixture(): VocabularyV2 {
  const definitions: DefinitionV2[] = [
    { id: 'id/text', code: 'text', label: ' Text ', type: 'text' },
    { id: 'id/boolean', code: 'boolean', label: 'Boolean', type: 'boolean' },
    {
      id: 'id/number',
      code: 'number',
      label: 'Number',
      type: 'number',
      units: [
        { code: 'kg', label: ' Kilograms ', sortOrder: 7 },
        { code: null, label: null, sortOrder: -1 },
      ],
      numericPolicy: { status: 'pending' },
    },
    {
      id: 'id/single',
      code: 'single',
      label: 'Single',
      type: 'single',
      options: [
        { code: 'z', label: 'Last', archived: true, sortOrder: 9 },
        { code: 'a', label: 'First', archived: false, sortOrder: -2 },
      ],
      groups: [{ code: 'group', label: ' Group ', optionCodes: ['z', 'a'] }],
      aliases: [{ label: ' Alias ', optionCode: 'z' }],
    },
    {
      id: 'id/multi',
      code: 'multi',
      label: 'Multi',
      type: 'multi',
      options: [],
      groups: [],
      aliases: [],
    },
  ];
  return {
    semanticsVersion: 'editorial-production-1',
    definitions,
    families: [
      {
        id: 'family/id',
        code: 'custom',
        label: ' Original ',
        minimumContractVersion: 1,
        bindings: definitions.map(
          (d, index): BindingV2 => ({
            definitionId: d.id,
            definitionCode: d.code,
            owner: index % 2 ? 'product' : 'sellable',
            sortOrder: 8 - index,
            exposure: index % 2 ? 'FACET' : 'DETAIL',
            searchable: index % 2 === 0,
            publicationCheck: index % 2 ? 'always' : 'when_asserted',
            policy: { route: 'pending' },
          }),
        ),
      },
    ],
  };
}
function numeric(
  input: VocabularyV2,
  type: 'number' | 'range',
  policy: NumericPolicyV2,
): void {
  const d = input.definitions[2];
  if (d.type !== 'number') throw new Error('fixture');
  d.type = type;
  if (type === 'range') d.units = d.units.filter((unit) => unit.code !== null);
  d.numericPolicy = policy;
}
const resolved: NumericPolicyV2 = {
  status: 'resolved',
  magnitude: 'custom',
  integer: false,
  lower: null,
  lowerInclusive: false,
  upper: null,
  upperInclusive: false,
};
const neutral: PolicyCase = {
  code: 'neutral',
  when: [],
  applicability: 'applicable',
  required: false,
  allowNA: false,
  evidenceRequired: false,
  documentary: 'not_applicable',
};
const advanced: Array<[string, (input: VocabularyV2) => void]> = [
  ['pending range', (v) => numeric(v, 'range', { status: 'pending' })],
  ['resolved range', (v) => numeric(v, 'range', resolved)],
  ['unrestricted resolved number', (v) => numeric(v, 'number', resolved)],
  [
    'bounded resolved number',
    (v) =>
      numeric(v, 'number', {
        ...resolved,
        lower: 0,
        lowerInclusive: true,
        upper: 10,
        upperInclusive: true,
      }),
  ],
  [
    'integer resolved number',
    (v) => numeric(v, 'number', { ...resolved, integer: true }),
  ],
  ...(
    [
      ['empty option cases', { route: 'option_cases', cases: [] }],
      [
        'unconditional neutral option case',
        { route: 'option_cases', cases: [neutral] },
      ],
      [
        'conditional option case',
        {
          route: 'option_cases',
          cases: [
            {
              ...neutral,
              when: [
                {
                  definitionCode: 'single',
                  operator: 'equals_set',
                  optionCodes: ['z'],
                },
              ],
            },
          ],
        },
      ],
      [
        'fact rule',
        {
          route: 'fact_rule',
          rule: {
            family: 'food',
            ruleId: 'required',
            parameter: 'animal.target',
          },
        },
      ],
    ] as Array<[string, BindingPolicy]>
  ).map(([name, policy]): [string, (input: VocabularyV2) => void] => [
    name,
    (v) => {
      v.families[0].bindings[0].policy = policy;
    },
  ]),
];
function freeze(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  Object.values(value).forEach(freeze);
  Object.freeze(value);
}
function prepare(input: VocabularyV2) {
  const parsed = validateVocabularyConsistencyV2(input);
  const byId = new Map(parsed.definitions.map((d) => [d.id, d]));
  freeze(parsed);
  const before = JSON.stringify(parsed);
  return { parsed, byId, before };
}
function run(input: VocabularyV2): void {
  const { parsed, byId, before } = prepare(input);
  try {
    expect(assertLegacy(parsed.families[0], byId)).toBeUndefined();
  } finally {
    expect(JSON.stringify(parsed)).toBe(before);
  }
}

describe('assertFamilyLegacyCompatibilityV2 conservative declaration', () => {
  it('preserves all five legacy types, null units, empty choices and ordered metadata', () => {
    run(fixture());
  });

  it.each(advanced)(
    'rejects V1 %s without mutation or implicit promotion',
    (_name, change) => {
      const input = fixture();
      change(input);
      const { parsed, byId, before } = prepare(input);
      let failure: unknown;
      try {
        assertLegacy(parsed.families[0], byId);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(TypeError);
      expect((failure as TypeError).message).toBe(errorMessage);
      expect(JSON.stringify(parsed)).toBe(before);
      expect(parsed.families[0].minimumContractVersion).toBe(1);
      expect(parsed.families[0].bindings).toHaveLength(5);
    },
  );

  it.each(advanced)(
    'accepts explicit V2 %s in this check only',
    (_name, change) => {
      const input = fixture();
      change(input);
      input.families[0].minimumContractVersion = 2;
      run(input);
    },
  );

  it('fails the whole family on a later binding, never pruning earlier bindings', () => {
    const input = fixture();
    input.families[0].bindings[4].policy = { route: 'option_cases', cases: [] };
    const { parsed, byId, before } = prepare(input);
    expect(() => assertLegacy(parsed.families[0], byId)).toThrow(errorMessage);
    expect(JSON.stringify(parsed)).toBe(before);
    expect(parsed.families[0].bindings.map((b) => b.definitionCode)).toEqual([
      'text',
      'boolean',
      'number',
      'single',
      'multi',
    ]);
  });

  it('uses actual IDs even when another definition ID equals the binding code', () => {
    const input = fixture();
    input.definitions.push({
      id: 'number',
      code: 'decoy',
      label: 'Decoy',
      type: 'text',
    });
    numeric(input, 'range', { status: 'pending' });
    const { parsed, byId } = prepare(input);
    expect(() => assertLegacy(parsed.families[0], byId)).toThrow(errorMessage);
  });

  it('does not reject a compatible binding because a code-keyed decoy is advanced', () => {
    const input = fixture();
    input.definitions.push({
      id: 'text',
      code: 'decoy',
      label: 'Decoy',
      type: 'range',
      units: [],
      numericPolicy: resolved,
    });
    run(input);
  });

  it('ignores unbound advanced definitions', () => {
    const input = fixture();
    numeric(input, 'range', resolved);
    input.families[0].bindings.splice(2, 1);
    run(input);
  });

  it('accepts an empty family without requiring seven production families', () => {
    const input = fixture();
    input.families[0].bindings = [];
    run(input);
  });

  it('accepts a pending numeric binding alone without requiring the other legacy types', () => {
    const input = fixture();
    input.families[0].bindings = [input.families[0].bindings[2]];
    run(input);
  });
});
