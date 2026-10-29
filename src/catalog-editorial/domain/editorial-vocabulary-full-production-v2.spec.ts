import { buildProductionVocabularyManifest } from '../../../prisma/editorial-production-vocabulary.manifest';
import * as comparison from './editorial-alias-comparison-v1';
import { FAMILY_CODES } from './editorial-production-vocabulary-catalog';
import type { ChoiceDefinitionV2 } from './editorial-vocabulary-choice-v2';
import * as generic from './editorial-vocabulary-consistency-v2';
import type { DefinitionV2 } from './editorial-vocabulary-definition-v2';
import type { FamilyV2 } from './editorial-vocabulary-family-shape-v2';
import { validateFullProductionVocabularyV2 as validate } from './editorial-vocabulary-full-production-v2';
import type { NumericDefinitionV2 } from './editorial-vocabulary-numeric-v2';
import * as aliases from './editorial-vocabulary-production-alias-coverage-v2';
import * as numeric from './editorial-vocabulary-production-numeric-v2';
import type { VocabularyV2 } from './editorial-vocabulary-shape-v2';

const incomplete = 'Expected a full production vocabulary V2';
function fixture(): VocabularyV2 {
  const manifest = buildProductionVocabularyManifest();
  const definitions = manifest.definitions.map((d, i) => ({
    ...d,
    id: `opaque/definition/${i}`,
  }));
  return generic.validateVocabularyConsistencyV2({
    semanticsVersion: 'editorial-production-1',
    definitions,
    families: manifest.families.map((f, i) => ({
      code: f.code,
      label: f.label,
      id: `opaque/family/${i}`,
      bindings: f.bindings.map((b) => ({
        ...b,
        definitionId: definitions.find((d) => d.code === b.definitionCode)!.id,
      })),
    })),
  });
}
function animal(v: VocabularyV2) {
  return v.definitions.find(
    (d) => d.code === 'animal.target',
  ) as ChoiceDefinitionV2;
}
function number(v: VocabularyV2) {
  return v.definitions.find((d) => d.type === 'number') as NumericDefinitionV2;
}
function custom(v: VocabularyV2, d?: DefinitionV2) {
  const family: FamilyV2 = {
    ...v.families[0],
    id: 'opaque/custom',
    code: 'custom',
    bindings: d
      ? [
          {
            ...v.families[0].bindings[0],
            definitionId: d.id,
            definitionCode: d.code,
            policy: { route: 'pending' as const },
          },
        ]
      : [],
  };
  v.families.push(family);
  return family;
}
function freeze(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}
function rejects(v: VocabularyV2, message?: string) {
  const before = JSON.stringify(v);
  freeze(v);
  expect(() => validate(v)).toThrow(
    message ? new TypeError(message) : TypeError,
  );
  expect(JSON.stringify(v)).toBe(before);
}

describe('validateFullProductionVocabularyV2 (dormant candidate composition)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('accepts the manifest with opaque IDs, returning a detached tree', () => {
    const v = fixture();
    const before = JSON.stringify(v);
    freeze(v);
    const parsed = validate(v);
    expect(parsed).toEqual(v);
    expect(parsed).not.toBe(v);
    expect(parsed.families[0].bindings[0]).not.toBe(v.families[0].bindings[0]);
    animal(parsed).options[0].label = 'Detached';
    expect(JSON.stringify(v)).toBe(before);
  });

  it('preserves validated extras, Unicode-equivalent aliases, labels, archives and order', () => {
    const v = fixture();
    const d = animal(v);
    d.options.push({
      code: 'extra',
      label: ' Extra ',
      archived: true,
      sortOrder: -3,
    });
    d.groups.push({
      code: 'extra',
      label: ' Extra group ',
      optionCodes: ['extra'],
    });
    d.groups[0].optionCodes.push('extra');
    d.aliases.push({ label: 'Extra alias', optionCode: 'extra' });
    d.aliases.find((a) => a.label === 'cuyo')!.label = 'CÚYO';
    d.options.reverse().forEach((o) => (o.archived = true));
    d.groups.reverse();
    d.aliases.reverse();
    v.definitions.reverse();
    v.families.reverse().forEach((f) => f.bindings.reverse());
    custom(v, d);
    const before = JSON.stringify(v);
    freeze(v);
    expect(validate(v)).toEqual(v);
    expect(JSON.stringify(v)).toBe(before);
  });

  it.each(FAMILY_CODES)(
    'requires canonical family %s with the exact root error',
    (code) => {
      const v = fixture();
      v.families = v.families.filter((f) => f.code !== code);
      custom(v);
      rejects(v, incomplete);
    },
  );

  it('keeps custom-only candidates generic-valid, not full-production valid', () => {
    const v = fixture();
    const f = custom(v, animal(v));
    v.families = [f];
    expect(generic.validateVocabularyConsistencyV2(v)).toEqual(v);
    rejects(v, incomplete);
  });

  const invalidProduction: Array<[string, (v: VocabularyV2) => void]> = [
    ['required definition missing', (v) => v.definitions.splice(0, 1)],
    [
      'extra canonical binding',
      (v) =>
        v.families[0].bindings.push({
          ...v.families[1].bindings.find(
            (b) =>
              !v.families[0].bindings.some(
                (x) => x.definitionCode === b.definitionCode,
              ),
          )!,
        }),
    ],
    [
      'canonical policy',
      (v) => {
        v.families[0].bindings[0].policy = { route: 'pending' };
      },
    ],
    [
      'canonical exposure',
      (v) => {
        v.families[0].bindings[0].exposure = 'INTERNAL';
      },
    ],
    [
      'numeric domain',
      (v) => {
        const p = number(v).numericPolicy;
        if (p.status === 'resolved') p.integer = !p.integer;
      },
    ],
    [
      'nonnumeric type',
      (v) => {
        const d = v.definitions.find((x) => x.type === 'text')!;
        v.definitions[v.definitions.indexOf(d)] = {
          id: d.id,
          code: d.code,
          label: d.label,
          type: 'boolean',
        };
      },
    ],
    [
      'required option',
      (v) => {
        const d = animal(v);
        const removed = d.options.pop()!.code;
        d.groups.forEach((g) => {
          g.optionCodes = g.optionCodes.filter((c) => c !== removed);
        });
        d.aliases = d.aliases.filter((a) => a.optionCode !== removed);
      },
    ],
    [
      'required group',
      (v) => {
        animal(v).groups.pop();
      },
    ],
    [
      'required alias',
      (v) => {
        animal(v).aliases.pop();
      },
    ],
    [
      'custom fact_rule',
      (v) => {
        const f = custom(v, animal(v));
        f.bindings[0].policy = v.families[0].bindings[0].policy;
      },
    ],
  ];
  it.each(invalidProduction)(
    'rejects composed production violation: %s',
    (_, mutate) => {
      const v = fixture();
      mutate(v);
      rejects(v);
    },
  );

  it.each(['policy', 'range', 'resolved number'] as const)(
    'accepts custom %s without a version declaration',
    (kind) => {
      const v = fixture();
      const d: DefinitionV2 =
        kind === 'policy'
          ? { id: 'custom/d', code: 'custom.d', label: 'Custom', type: 'text' }
          : {
              ...number(v),
              id: 'custom/d',
              code: 'custom.d',
              type: kind === 'range' ? 'range' : 'number',
            };
      v.definitions.push(d);
      const f = custom(v, d);
      if (kind === 'policy')
        f.bindings[0].policy = { route: 'option_cases', cases: [] };
      expect(generic.validateVocabularyConsistencyV2(v)).toEqual(v);
      expect(validate(v)).toEqual(v);
    },
  );

  it('accepts a custom pending number without imposing production numeric domains', () => {
    const v = fixture();
    const d: DefinitionV2 = {
      ...number(v),
      id: 'custom/pending',
      code: 'custom.pending',
      numericPolicy: { status: 'pending' },
    };
    v.definitions.push(d);
    custom(v, d);
    freeze(v);
    expect(validate(v)).toEqual(v);
  });

  it('accepts a custom binding sharing a production resolved number', () => {
    const v = fixture();
    custom(v, number(v));
    expect(validate(v)).toEqual(v);
  });

  it('runs custom static option-case consistency before production admission', () => {
    const v = fixture();
    const f = custom(v, animal(v));
    const c = {
      code: 'a',
      when: [],
      applicability: 'applicable' as const,
      required: false,
      allowNA: false,
      evidenceRequired: false,
      documentary: 'not_applicable' as const,
    };
    f.bindings[0].policy = {
      route: 'option_cases',
      cases: [c, { ...c, code: 'b' }],
    };
    rejects(v);
  });

  it.each([false, true])(
    'retains production checks beside resolved custom metadata (custom first: %s)',
    (first) => {
      const v = fixture();
      v.families[0].bindings[0].exposure = 'INTERNAL';
      const f = custom(v, number(v));
      if (first) v.families = [f, ...v.families.slice(0, -1)];
      const spy = jest.spyOn(numeric, 'assertProductionNumericDefinitionsV2');
      rejects(v, 'Expected production binding policies V2');
      expect(spy).toHaveBeenCalled();
    },
  );

  it('retains root completeness beside resolved custom metadata', () => {
    const v = fixture();
    const f = custom(v, number(v));
    v.families = [f];
    rejects(v, incomplete);
  });

  it('calls generic then numeric/alias per family including custom, by actual IDs', () => {
    const v = fixture();
    custom(v, animal(v));
    const order: string[] = [];
    const original = generic.validateVocabularyConsistencyV2;
    jest
      .spyOn(generic, 'validateVocabularyConsistencyV2')
      .mockImplementation((input) => {
        order.push('generic');
        return original(input);
      });
    const checkNumeric = numeric.assertProductionNumericDefinitionsV2;
    jest
      .spyOn(numeric, 'assertProductionNumericDefinitionsV2')
      .mockImplementation((f, map) => {
        order.push(`numeric:${f.code}`);
        expect(map.get(v.definitions[0].id)).toEqual(v.definitions[0]);
        expect(map.has(v.definitions[0].code)).toBe(false);
        checkNumeric(f, map);
      });
    const checkAliases = aliases.assertProductionAliasCoverageV2;
    jest
      .spyOn(aliases, 'assertProductionAliasCoverageV2')
      .mockImplementation((f, map) => {
        order.push(`alias:${f.code}`);
        checkAliases(f, map);
      });
    validate(v);
    expect(order).toEqual([
      'generic',
      ...v.families.flatMap((f) => [`numeric:${f.code}`, `alias:${f.code}`]),
    ]);
  });

  it('propagates generic failures and Unicode runtime errors by identity', () => {
    const v = fixture();
    const failure = new Error('generic sentinel');
    jest
      .spyOn(generic, 'validateVocabularyConsistencyV2')
      .mockImplementationOnce(() => {
        throw failure;
      });
    try {
      validate(v);
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBe(failure);
    }
    const unicode = new Error('unsupported Unicode runtime');
    jest
      .spyOn(comparison, 'editorialAliasComparisonKeyV1')
      .mockImplementation(() => {
        throw unicode;
      });
    try {
      validate(v);
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBe(unicode);
    }
  });
});
