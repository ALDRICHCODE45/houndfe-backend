import { buildProductionVocabularyManifest } from '../../../prisma/editorial-production-vocabulary.manifest';
import * as dispatcher from './editorial-binding-policy-evaluation-v2';
import type { FactInputsV2 } from './editorial-fact-rule-evaluation-v2';
import { assertFreshNAAdmissionV2 } from './editorial-na-admission-v2';
import type { RuleResultV2 } from './editorial-option-case-evaluation-v2';
import type {
  BindingV2,
  FamilyV2,
} from './editorial-vocabulary-family-shape-v2';
import { validateFullProductionVocabularyV2 } from './editorial-vocabulary-full-production-v2';
import type { BindingPolicy } from './editorial-vocabulary-policy-shape-v2';
import type { ValueV2 } from './editorial-value-shape-v2';

const permitted: RuleResultV2 = {
  applicability: 'not_applicable',
  required: false,
  allowNA: true,
  evidenceRequired: true,
  documentary: 'unresolved',
};
const optionPolicy: BindingPolicy = {
  route: 'option_cases',
  cases: [{ code: 'negative', when: [], ...permitted }],
};
function binding(
  code = 'target',
  policy = optionPolicy,
  owner: BindingV2['owner'] = 'sellable',
): BindingV2 {
  return {
    definitionId: `id/${code}`,
    definitionCode: code,
    owner,
    sortOrder: 0,
    exposure: 'INTERNAL',
    searchable: false,
    publicationCheck: 'when_asserted',
    policy,
  };
}
function family(...bindings: BindingV2[]): FamilyV2 {
  return { id: 'custom', code: 'custom', label: 'Custom', bindings };
}
function na(code = 'target', variantId: string | null = 'a'): ValueV2 {
  return {
    code,
    owner: 'sellable',
    variantId,
    state: 'not_applicable',
    evidence: null,
  };
}
function choice(variantId: string | null, selected: string): ValueV2 {
  return {
    code: 'selector',
    owner: variantId === null ? 'product' : 'sellable',
    variantId,
    state: 'known',
    payload: { type: 'single', value: selected },
    evidence: null,
  };
}
function conditional(owner: BindingV2['owner']): FamilyV2 {
  return family(
    binding(
      'target',
      {
        route: 'option_cases',
        cases: [
          {
            code: 'negative',
            when: [
              {
                definitionCode: 'selector',
                operator: 'equals_set',
                optionCodes: ['no'],
              },
            ],
            ...permitted,
          },
        ],
      },
      owner,
    ),
    binding('selector', { route: 'pending' }, owner),
  );
}
function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}
const manifest = buildProductionVocabularyManifest();
const definitions = manifest.definitions.map((d, i) => ({
  ...d,
  id: `db/${i}`,
}));
const production = validateFullProductionVocabularyV2({
  semanticsVersion: manifest.semanticsVersion,
  definitions,
  families: manifest.families.map((f, i) => ({
    id: `family/${i}`,
    code: f.code,
    label: f.label,
    bindings: f.bindings.map((b) => ({
      ...b,
      definitionId: definitions.find((d) => d.code === b.definitionCode)!.id,
    })),
  })),
});
const productionFamily = (code: string) =>
  production.families.find((f) => f.code === code)!;
const emptyFacts: ReadonlyMap<string | null, FactInputsV2> = new Map();

describe('assertFreshNAAdmissionV2 (T3f S35/S45; S44/S46 retained)', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['not_applicable', true, true],
    ['not_applicable', false, false],
    ['applicable', true, false],
    ['applicable', false, false],
    ['unresolved', true, false],
    ['unresolved', false, false],
  ] as const)(
    'requires the conjunction %s / allowNA=%s',
    (applicability, allowNA, allowed) => {
      jest.spyOn(dispatcher, 'evaluateBindingPolicyV2').mockReturnValue({
        ...permitted,
        applicability,
        allowNA,
      });
      const check = () =>
        assertFreshNAAdmissionV2([na()], family(binding()), emptyFacts);
      if (allowed) expect(check).not.toThrow();
      else expect(check).toThrow(new Error('MALFORMED'));
    },
  );

  it('rejects a null selection and a real pending policy', () => {
    const spy = jest
      .spyOn(dispatcher, 'evaluateBindingPolicyV2')
      .mockReturnValue(null);
    expect(() =>
      assertFreshNAAdmissionV2([na()], family(binding()), emptyFacts),
    ).toThrow('MALFORMED');
    spy.mockRestore();
    expect(() =>
      assertFreshNAAdmissionV2(
        [na()],
        family(binding('target', { route: 'pending' })),
        emptyFacts,
      ),
    ).toThrow('MALFORMED');
  });

  it('rejects a missing NA binding before dispatch', () => {
    const spy = jest.spyOn(dispatcher, 'evaluateBindingPolicyV2');
    expect(() =>
      assertFreshNAAdmissionV2([na()], family(), emptyFacts),
    ).toThrow('MALFORMED');
    expect(spy).not.toHaveBeenCalled();
  });

  it('dispatches each NA with exact original policy, family, values, subject and fact row', () => {
    const f = productionFamily('hygiene');
    const values = [na('animal.target', 'a'), na('animal.target', 'b')];
    const a: FactInputsV2 = { animalApplied: false };
    const b: FactInputsV2 = { animalApplied: false, consumable: true };
    const facts = new Map([
      ['a', a],
      ['b', b],
    ]);
    const spy = jest.spyOn(dispatcher, 'evaluateBindingPolicyV2');
    assertFreshNAAdmissionV2(values, f, facts);
    expect(spy).toHaveBeenCalledTimes(2);
    for (const [index, subject, row] of [
      [0, 'a', a],
      [1, 'b', b],
    ] as const) {
      const args = spy.mock.calls[index];
      expect(args[0]).toBe(
        f.bindings.find((item) => item.definitionCode === 'animal.target')!
          .policy,
      );
      expect(args[1]).toBe(f);
      expect(args[2]).toBe(values);
      expect(args[3]).toBe(subject);
      expect(args[4]).toBe(row);
    }
  });

  it.each([undefined, {}] as const)(
    'missing/unknown exact facts never borrow sibling or null facts: %j',
    (own) => {
      const facts = new Map<string | null, FactInputsV2>([
        ['b', { animalApplied: false }],
        [null, { animalApplied: false }],
      ]);
      if (own) facts.set('a', own);
      const spy = jest.spyOn(dispatcher, 'evaluateBindingPolicyV2');
      expect(() =>
        assertFreshNAAdmissionV2(
          [na('animal.target')],
          productionFamily('hygiene'),
          facts,
        ),
      ).toThrow('MALFORMED');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][4]).toEqual({});
    },
  );

  it('uses evidenced-negative N, but S46 optional O does not permit explicit NA', () => {
    expect(() =>
      assertFreshNAAdmissionV2(
        [na('animal.target')],
        productionFamily('hygiene'),
        new Map([['a', { animalApplied: false }]]),
      ),
    ).not.toThrow();
    expect(() =>
      assertFreshNAAdmissionV2(
        [na('measure.equipment.power')],
        productionFamily('accessory'),
        new Map([
          ['a', { relevantEquipmentCodes: ['measure.equipment.power'] }],
        ]),
      ),
    ).toThrow('MALFORMED');
  });

  it('matches only the current sellable selector, never its sibling', () => {
    const f = conditional('sellable');
    expect(() =>
      assertFreshNAAdmissionV2(
        [na(), choice('a', 'no'), choice('b', 'yes')],
        f,
        emptyFacts,
      ),
    ).not.toThrow();
    expect(() =>
      assertFreshNAAdmissionV2(
        [na(), choice('a', 'yes'), choice('b', 'no')],
        f,
        emptyFacts,
      ),
    ).toThrow('MALFORMED');
  });

  it('reads a product selector at null for a sellable target without reading facts', () => {
    const f = conditional('sellable');
    f.bindings[1].owner = 'product';
    const get = jest.fn(() => {
      throw new Error('option route read facts');
    });
    const facts: ReadonlyMap<string | null, FactInputsV2> = new Map();
    jest.spyOn(facts, 'get').mockImplementation(get);
    expect(() =>
      assertFreshNAAdmissionV2([na(), choice(null, 'no')], f, facts),
    ).not.toThrow();
    expect(get).not.toHaveBeenCalled();
  });

  it('evaluates a product NA once at null, not once per variant (S44)', () => {
    const f = conditional('product');
    const target = { ...na('target', null), owner: 'product' as const };
    const values = [target, choice(null, 'no')];
    const facts = new Map<string | null, FactInputsV2>([
      ['a', {}],
      ['b', {}],
    ]);
    const spy = jest.spyOn(dispatcher, 'evaluateBindingPolicyV2');
    assertFreshNAAdmissionV2(values, f, facts);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][3]).toBeNull();
  });

  it('skips known and unknown values, including known contradictions to selected NA', () => {
    const values: ValueV2[] = [
      choice(null, 'asserted'),
      {
        code: 'target',
        owner: 'sellable',
        variantId: 'a',
        state: 'unknown',
        evidence: null,
      },
    ];
    const f = family(binding('selector', optionPolicy, 'product'), binding());
    const spy = jest
      .spyOn(dispatcher, 'evaluateBindingPolicyV2')
      .mockImplementation(() => {
        throw new Error('non-NA evaluated');
      });
    expect(() => assertFreshNAAdmissionV2(values, f, emptyFacts)).not.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it('checks later inactive/when_asserted NA too, without an E filter', () => {
    const f = family(binding('first'), binding('later', { route: 'pending' }));
    expect(() =>
      assertFreshNAAdmissionV2(
        [na('first', 'active'), na('later', 'inactive')],
        f,
        emptyFacts,
      ),
    ).toThrow('MALFORMED');
  });

  it('permits null value evidence despite evidenceRequired and unresolved documentary metadata', () => {
    expect(() =>
      assertFreshNAAdmissionV2([na()], family(binding()), emptyFacts),
    ).not.toThrow();
  });

  it('documentary readiness alone never grants fresh NA permission', () => {
    const policy: BindingPolicy = {
      route: 'option_cases',
      cases: [
        {
          code: 'ready',
          when: [],
          ...permitted,
          applicability: 'applicable',
          allowNA: false,
          documentary: 'resolved',
        },
      ],
    };
    expect(() =>
      assertFreshNAAdmissionV2(
        [na()],
        family(binding('target', policy)),
        emptyFacts,
      ),
    ).toThrow('MALFORMED');
  });

  it.each([true, false])(
    'preserves frozen inputs on allowed=%s admission',
    (allowed) => {
      const values = [na('animal.target')];
      const f = productionFamily('hygiene');
      const facts = new Map<string | null, FactInputsV2>([
        ['a', { animalApplied: allowed ? false : true }],
      ]);
      const before = JSON.stringify([values, f, [...facts]]);
      freeze([values, f, [...facts]]);
      Object.freeze(facts);
      const check = () => assertFreshNAAdmissionV2(values, f, facts);
      if (allowed) expect(check).not.toThrow();
      else expect(check).toThrow('MALFORMED');
      expect(JSON.stringify([values, f, [...facts]])).toBe(before);
    },
  );

  it.each([new RangeError('unexpected'), new Error('MALFORMED'), 'sentinel'])(
    'preserves unexpected dispatcher error identity: %j',
    (sentinel) => {
      jest
        .spyOn(dispatcher, 'evaluateBindingPolicyV2')
        .mockImplementation(() => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- Exercise non-Error identity too.
          throw sentinel;
        });
      let caught: unknown;
      try {
        assertFreshNAAdmissionV2([na()], family(binding()), emptyFacts);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(sentinel);
    },
  );
});
