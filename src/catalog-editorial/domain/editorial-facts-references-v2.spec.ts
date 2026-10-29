import { buildProductionVocabularyManifest } from '../../../prisma/editorial-production-vocabulary.manifest';
import type { DeclarationShapeV2 } from './editorial-declaration-shape-v2';
import { assertFreshFactsReferencesV2 as assertReferences } from './editorial-facts-references-v2';
import {
  FAMILY_CODES,
  NUMBERS,
} from './editorial-production-vocabulary-catalog';
import type { SellableFactsShapeV2 } from './editorial-sellable-facts-shape-v2';
import type { ChoiceDefinitionV2 } from './editorial-vocabulary-choice-v2';
import type { FamilyV2 } from './editorial-vocabulary-family-shape-v2';
import { validateFullProductionVocabularyV2 } from './editorial-vocabulary-full-production-v2';

const manifest = buildProductionVocabularyManifest();
const definitions = manifest.definitions.map((d, i) => ({
  ...d,
  id: `db/${i}`,
}));
const vocabulary = validateFullProductionVocabularyV2({
  semanticsVersion: manifest.semanticsVersion,
  definitions,
  families: manifest.families.map((f, i) => ({
    ...f,
    id: `family/${i}`,
    bindings: f.bindings.map((b) => ({
      ...b,
      definitionId: definitions.find((d) => d.code === b.definitionCode)!.id,
    })),
  })),
});
const byId = new Map(vocabulary.definitions.map((d) => [d.id, d]));
// Custom V1 uses pending numeric metadata and no range bindings (S18).
const customById = new Map(
  vocabulary.definitions.map((d) => [
    d.id,
    d.type === 'number'
      ? { ...d, numericPolicy: { status: 'pending' as const } }
      : d,
  ]),
);
const family = (code: string) =>
  structuredClone(vocabulary.families.find((f) => f.code === code)!);
function known(
  key: DeclarationShapeV2['key'],
  value: unknown,
): DeclarationShapeV2 {
  return {
    key,
    state: 'known',
    value,
    evidence: { sourceRef: 'manual', verifiedOn: '2026-01-01' },
    basis: 'manufacturer',
  } as DeclarationShapeV2;
}
function row(declaration?: DeclarationShapeV2): SellableFactsShapeV2 {
  return {
    variantId: 'inactive-real-subject',
    presentation: 'Exact',
    declarations: declaration ? [declaration] : [],
    careReview: null,
  };
}
function check(declaration: DeclarationShapeV2, f = family('accessory')) {
  return assertReferences(
    row(declaration),
    f,
    f.code === 'custom' ? customById : byId,
  );
}
function reject(declaration: DeclarationShapeV2, f = family('accessory')) {
  expect(() => check(declaration, f)).toThrow(new Error('MALFORMED'));
}
function custom(version: 1 | 2 = 2): FamilyV2 {
  const f = family('hygiene');
  return {
    ...f,
    code: 'custom',
    minimumContractVersion: version,
    bindings: f.bindings
      .filter(
        (b) => version === 2 || byId.get(b.definitionId)!.type !== 'range',
      )
      .map((b) => ({ ...b, policy: { route: 'pending' } })),
  };
}
function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}
const permissions: [DeclarationShapeV2['key'], unknown, string[]][] = [
  ['contentMagnitude', 'mass', [...FAMILY_CODES]],
  ['optionalNonpertinenceCodes', [], [...FAMILY_CODES]],
  ['consumable', false, ['hygiene']],
  ['animalApplied', false, ['hygiene']],
  [
    'relevantDimensionCodes',
    { codes: [], toyTypes: [] },
    ['toy', 'hygiene', 'accessory', 'habitat', 'care'],
  ],
  ['fitDeterminesChoice', false, ['accessory']],
  ['relevantFitCodes', [], ['accessory']],
  ['capacityDeterminesChoice', false, ['accessory']],
  ['relevantCapacityCodes', [], ['accessory', 'habitat']],
  ['electricalApplies', false, ['accessory', 'habitat']],
  ['relevantEquipmentCodes', [], ['accessory', 'habitat']],
  ['presentationKind', 'device', ['care']],
];

describe('fresh facts references (T3d S2/S34)', () => {
  it.each(permissions)(
    'checks %s family permission before known/unknown dispatch',
    (key, value, allowed) => {
      for (const code of FAMILY_CODES) {
        for (const declaration of [
          known(key, value),
          { key, state: 'unknown' as const, evidence: null },
        ]) {
          if (allowed.includes(code)) check(declaration, family(code));
          else reject(declaration, family(code));
        }
      }
    },
  );
  it.each([
    ['mass', 'measure.net_mass'],
    ['volume', 'measure.net_volume'],
    ['count', 'measure.content_count'],
    ['length', 'measure.coverage.length'],
    ['area', 'measure.coverage.area'],
  ])('resolves %s to its actual bound canonical measure', (magnitude, code) => {
    const f = family('hygiene');
    check(known('contentMagnitude', magnitude), f);
    f.bindings = f.bindings.filter((b) => b.definitionCode !== code);
    // Deliberate precondition-mismatch probe: admitted production families have exact bindings.
    reject(known('contentMagnitude', magnitude), f);
    check({ key: 'contentMagnitude', state: 'unknown', evidence: null }, f);
  });
  it('does not substitute pack_count for content_count', () => {
    const f = custom();
    f.bindings = f.bindings.filter(
      (b) => b.definitionCode === 'measure.pack_count',
    );
    reject(known('contentMagnitude', 'count'), f);
  });
  it.each([
    ['relevantDimensionCodes', 'measure.dimensions.', 'toy'],
    ['relevantFitCodes', 'measure.fit.', 'accessory'],
    ['relevantCapacityCodes', 'measure.capacity.', 'habitat'],
    ['relevantEquipmentCodes', 'measure.equipment.', 'habitat'],
  ] as const)(
    'requires finite inventory membership and actual binding for %s',
    (key, prefix, code) => {
      const declaration = (axis: string) =>
        known(
          key,
          key === 'relevantDimensionCodes'
            ? { codes: [axis], toyTypes: [] }
            : [axis],
        );
      for (const [axis] of NUMBERS.filter(([axis]) =>
        axis.startsWith(prefix),
      )) {
        check(declaration(axis), family(code));
      }
      reject(declaration(`${prefix}invented`), family(code));
      reject(declaration('measure.net_mass'), family(code));
      const f = family(code);
      const axis = NUMBERS.find(([axis]) => axis.startsWith(prefix))![0];
      f.bindings = f.bindings.filter((b) => b.definitionCode !== axis);
      // Deliberate missing-binding probe, not a production-admission fixture.
      reject(declaration(axis), f);
    },
  );
  it('restricts accessory capacity to container even with a foreign actual binding', () => {
    check(known('relevantCapacityCodes', ['measure.capacity.container']));
    const f = family('accessory');
    f.bindings.push(
      family('habitat').bindings.find(
        (b) => b.definitionCode === 'measure.capacity.habitat_usable_volume',
      )!,
    );
    // Intentional metadata-precondition mismatch protects the family-specific restriction.
    reject(
      known('relevantCapacityCodes', [
        'measure.capacity.habitat_usable_volume',
      ]),
      f,
    );
  });
  it('uses exact actual toy options, not groups, aliases or foreign options', () => {
    const f = family('toy');
    const binding = f.bindings.find((b) => b.definitionCode === 'toy.type')!;
    const toy = structuredClone(
      byId.get(binding.definitionId),
    ) as ChoiceDefinitionV2;
    toy.options.push({
      code: 'extra-actual',
      label: 'Extra',
      archived: false,
      sortOrder: 99,
    });
    toy.groups.push({
      code: 'group-only',
      label: 'Group',
      optionCodes: [toy.options[0].code],
    });
    toy.aliases.push({ label: 'alias-only', optionCode: toy.options[0].code });
    const metadata = new Map(byId).set(toy.id, toy);
    const d = (toyTypes: string[]) =>
      row(known('relevantDimensionCodes', { codes: [], toyTypes }));
    assertReferences(d(['extra-actual', toy.options[0].code]), f, metadata);
    for (const code of [
      'group-only',
      'alias-only',
      'foreign',
      toy.options[0].label,
    ]) {
      expect(() => assertReferences(d([code]), f, metadata)).toThrow(
        'MALFORMED',
      );
    }
    // No selected toy.type values are supplied: selected-set equality belongs to publish.
    reject(
      known('relevantDimensionCodes', {
        codes: [],
        toyTypes: [toy.options[0].code],
      }),
      family('hygiene'),
    );
  });
  it('fails closed on definition ID/code disagreement (intentional precondition mismatch)', () => {
    const f = family('toy');
    f.bindings.find((b) => b.definitionCode === 'toy.type')!.definitionId =
      'missing';
    reject(
      known('relevantDimensionCodes', { codes: [], toyTypes: ['foreign'] }),
      f,
    );
    const mass = family('food');
    mass.bindings.find(
      (b) => b.definitionCode === 'measure.net_mass',
    )!.definitionId = definitions[0].id;
    reject(known('contentMagnitude', 'mass'), mass);
  });
  it('accepts optional fact routes, not required, conditional, content or optional_equipment', () => {
    check(
      known('optionalNonpertinenceCodes', ['life.stage', 'measure.pack_count']),
    );
    for (const code of [
      'accessory.type',
      'measure.fit.neck',
      'measure.net_mass',
      'measure.equipment.power',
      'missing',
    ]) {
      reject(known('optionalNonpertinenceCodes', [code]));
    }
  });
  it.each([
    'pending',
    'option_cases',
    'wrong-family',
    'wrong-parameter',
  ] as const)(
    'does not infer optional authority from when_asserted: %s',
    (route) => {
      const f = family('accessory');
      const b = f.bindings.find((b) => b.definitionCode === 'life.stage')!;
      // Deliberate admission-mismatch probes; the gate is not metadata admission.
      if (route === 'pending') b.policy = { route: 'pending' };
      else if (route === 'option_cases')
        b.policy = { route: 'option_cases', cases: [] };
      else if (b.policy.route === 'fact_rule') {
        if (route === 'wrong-family') b.policy.rule.family = 'food';
        else b.policy.rule.parameter = 'pack.sale';
      }
      reject(known('optionalNonpertinenceCodes', ['life.stage']), f);
    },
  );
  it('allows nonnull care capture only in care, including unknown', () => {
    for (const careReview of [
      { state: 'unknown' as const },
      {
        state: 'prepared' as const,
        jurisdiction: '',
        intendedUse: '',
        determination: 'none_applicable' as const,
        evidence: [],
        basis: '',
        requirements: [],
        warnings: [],
      },
    ]) {
      for (const code of [...FAMILY_CODES, 'custom']) {
        const f = code === 'custom' ? custom() : family(code);
        const candidate = { ...row(), careReview };
        if (code === 'care') assertReferences(candidate, f, byId);
        else
          expect(() => assertReferences(candidate, f, byId)).toThrow(
            'MALFORMED',
          );
      }
    }
  });
  it.each([1, 2] as const)(
    'custom minimum version %s confers only S34 permissions',
    (version) => {
      const f = custom(version);
      for (const magnitude of ['mass', 'volume', 'count', 'length', 'area'])
        check(known('contentMagnitude', magnitude), f);
      check({ key: 'contentMagnitude', state: 'unknown', evidence: null }, f);
      check(
        { key: 'optionalNonpertinenceCodes', state: 'unknown', evidence: null },
        f,
      );
      check(known('optionalNonpertinenceCodes', []), f);
      reject(known('optionalNonpertinenceCodes', ['life.stage']), f);
      for (const [key, value] of permissions.filter(
        ([key]) =>
          !['contentMagnitude', 'optionalNonpertinenceCodes'].includes(key),
      )) {
        reject(known(key, value), f);
        reject({ key, state: 'unknown', evidence: null }, f);
      }
      f.bindings = [];
      reject(known('contentMagnitude', 'mass'), f);
      check({ key: 'contentMagnitude', state: 'unknown', evidence: null }, f);
    },
  );
  it.each([false, true])(
    'preserves deeply frozen inputs on failure=%s',
    (fails) => {
      const f = family('accessory');
      const candidate = row(
        known('relevantCapacityCodes', [
          fails ? 'foreign' : 'measure.capacity.container',
        ]),
      );
      const metadata = new Map(
        [...byId].map(([id, d]) => [id, structuredClone(d)]),
      );
      const inputs = [candidate, f, [...metadata]];
      const before = JSON.stringify(inputs);
      freeze(inputs);
      if (fails)
        expect(() => assertReferences(candidate, f, metadata)).toThrow(
          new Error('MALFORMED'),
        );
      else assertReferences(candidate, f, metadata);
      expect(JSON.stringify(inputs)).toBe(before);
    },
  );
});
