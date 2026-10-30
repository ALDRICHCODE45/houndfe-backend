import { buildProductionVocabularyManifest } from '../../../prisma/editorial-production-vocabulary.manifest';
import { evaluateBindingPolicyV2 } from './editorial-binding-policy-evaluation-v2';
import {
  parseDeclarationShapeV2,
  type DeclarationShapeV2,
} from './editorial-declaration-shape-v2';
import * as capture from './editorial-facts-capture-v2';
import { qualifyFactsV2 } from './editorial-facts-qualification-v2';
import * as references from './editorial-facts-references-v2';
import type { FactInputsV2 } from './editorial-fact-rule-evaluation-v2';
import type { SellableFactsShapeV2 } from './editorial-sellable-facts-shape-v2';
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
    id: `family/${i}`,
    code: f.code,
    label: f.label,
    bindings: f.bindings.map((b) => ({
      ...b,
      definitionId: definitions.find((d) => d.code === b.definitionCode)!.id,
    })),
  })),
});
const byId = new Map(vocabulary.definitions.map((d) => [d.id, d]));
const family = (code: string) =>
  structuredClone(vocabulary.families.find((f) => f.code === code)!);
function known(
  key: DeclarationShapeV2['key'],
  value: unknown,
): DeclarationShapeV2 {
  return parseDeclarationShapeV2({
    key,
    state: 'known',
    value,
    evidence: { sourceRef: 'manual', verifiedOn: '2026-01-01' },
    basis: 'manufacturer',
  });
}
function unknown(key: DeclarationShapeV2['key']): DeclarationShapeV2 {
  return { key, state: 'unknown', evidence: null };
}
function row(...declarations: DeclarationShapeV2[]): SellableFactsShapeV2 {
  return {
    variantId: null,
    presentation: 'Exact',
    declarations,
    careReview: null,
  };
}
function project(candidate: SellableFactsShapeV2, f = family('accessory')) {
  return qualifyFactsV2(candidate, f, byId);
}
function custom(): FamilyV2 {
  return {
    ...family('hygiene'),
    code: 'custom',
    bindings: family('hygiene').bindings.map((b) => ({
      ...b,
      policy: { route: 'pending' },
    })),
  };
}
function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}
const samples: [DeclarationShapeV2['key'], unknown, string][] = [
  ['contentMagnitude', 'mass', 'food'],
  ['consumable', false, 'hygiene'],
  ['animalApplied', false, 'hygiene'],
  ['fitDeterminesChoice', false, 'accessory'],
  ['capacityDeterminesChoice', false, 'accessory'],
  ['electricalApplies', false, 'habitat'],
  ['relevantDimensionCodes', { codes: [], toyTypes: [] }, 'toy'],
  ['relevantFitCodes', [], 'accessory'],
  ['relevantCapacityCodes', [], 'habitat'],
  ['relevantEquipmentCodes', [], 'accessory'],
  ['presentationKind', 'device', 'care'],
  ['optionalNonpertinenceCodes', [], 'treat'],
];

describe('qualifyFactsV2 (T3f S35/S45, preserving S34/S42/S46)', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each(samples)(
    'projects known %s and omits its unknown declaration',
    (key, value, code) => {
      expect(project(row(known(key, value)), family(code))).toEqual({
        [key]: value,
      });
      const result = project(row(unknown(key)), family(code));
      expect(result).toEqual({});
      expect(Object.hasOwn(result, key)).toBe(false);
    },
  );

  it('returns independent empty results for present rows without declarations', () => {
    const first = project(row());
    expect(first).toEqual({});
    expect(project(row())).not.toBe(first);
  });

  it.each(['evidence', 'basis', 'duplicate'] as const)(
    'rejects bad known %s rather than downgrading to unknown',
    (defect) => {
      const declaration = known('electricalApplies', false);
      if (declaration.state !== 'known') throw new Error('fixture');
      if (defect === 'evidence') declaration.evidence.verifiedOn = '2026-02-30';
      if (defect === 'basis') declaration.basis = ' ';
      const candidate = row(declaration);
      if (defect === 'duplicate')
        candidate.declarations.push(unknown(declaration.key));
      expect(() => project(candidate)).toThrow(new Error('MALFORMED'));
    },
  );

  it('runs capture then references with original arguments before reading projection values', () => {
    const candidate = row(known('contentMagnitude', 'mass'));
    const f = family('food');
    const order: string[] = [];
    const originalCapture = capture.assertFreshFactsCaptureV2;
    const originalReferences = references.assertFreshFactsReferencesV2;
    jest
      .spyOn(capture, 'assertFreshFactsCaptureV2')
      .mockImplementation((input) => {
        expect(input).toBe(candidate);
        order.push('capture');
        originalCapture(input);
      });
    jest
      .spyOn(references, 'assertFreshFactsReferencesV2')
      .mockImplementation((input, admitted, map) => {
        expect([input, admitted, map]).toEqual([candidate, f, byId]);
        expect(input).toBe(candidate);
        expect(admitted).toBe(f);
        expect(map).toBe(byId);
        order.push('references');
        originalReferences(input, admitted, map);
      });
    expect(project(candidate, f)).toEqual({ contentMagnitude: 'mass' });
    expect(order).toEqual(['capture', 'references']);
  });

  it.each(['capture', 'references'] as const)(
    'preserves unexpected %s errors by identity without projecting',
    (stage) => {
      const candidate = row(known('contentMagnitude', 'mass'));
      const declaration = candidate.declarations[0];
      const sentinel = new RangeError('unexpected');
      const later = jest.spyOn(references, 'assertFreshFactsReferencesV2');
      if (stage === 'capture')
        jest
          .spyOn(capture, 'assertFreshFactsCaptureV2')
          .mockImplementation(() => {
            throw sentinel;
          });
      else
        later.mockImplementation(() => {
          throw sentinel;
        });
      const read = jest.fn(() => 'mass');
      Object.defineProperty(declaration, 'value', { get: read });
      try {
        project(candidate, family('food'));
        throw new Error('expected failure');
      } catch (error) {
        expect(error).toBe(sentinel);
      }
      expect(read).not.toHaveBeenCalled();
      if (stage === 'capture') expect(later).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['relevantFitCodes', ['invented']],
    ['relevantEquipmentCodes', ['measure.net_mass']],
    ['optionalNonpertinenceCodes', ['measure.equipment.power']],
    ['optionalNonpertinenceCodes', ['accessory.type']],
  ] as [DeclarationShapeV2['key'], string[]][])(
    'rejects invalid references or non-optional route in %s',
    (key, value) => {
      expect(() => project(row(known(key, value)))).toThrow('MALFORMED');
    },
  );

  it('rejects an unbound canonical measure, but unknown content needs no measure', () => {
    const f = custom();
    f.bindings = [];
    expect(() => project(row(known('contentMagnitude', 'mass')), f)).toThrow(
      'MALFORMED',
    );
    expect(project(row(unknown('contentMagnitude')), f)).toEqual({});
  });

  it('retains S34 bound custom content and empty/unknown optional lists', () => {
    expect(
      project(
        row(
          known('contentMagnitude', 'mass'),
          known('optionalNonpertinenceCodes', []),
        ),
        custom(),
      ),
    ).toEqual({ contentMagnitude: 'mass', optionalNonpertinenceCodes: [] });
    expect(
      project(
        row(unknown('contentMagnitude'), unknown('optionalNonpertinenceCodes')),
        custom(),
      ),
    ).toEqual({});
    expect(() =>
      project(
        row(known('optionalNonpertinenceCodes', ['life.stage'])),
        custom(),
      ),
    ).toThrow('MALFORMED');
  });

  it.each(
    samples.filter(
      ([key]) =>
        !['contentMagnitude', 'optionalNonpertinenceCodes'].includes(key),
    ),
  )('rejects S34 forbidden custom %s even when unknown', (key, value) => {
    for (const declaration of [known(key, value), unknown(key)])
      expect(() => project(row(declaration), custom())).toThrow('MALFORMED');
  });

  it('deeply detaches every mutable projected branch while preserving frozen inputs', () => {
    const f = family('accessory');
    const candidate = row(
      known('relevantDimensionCodes', {
        codes: ['measure.dimensions.external_length'],
        toyTypes: [],
      }),
      known('relevantFitCodes', ['measure.fit.neck']),
      known('relevantCapacityCodes', ['measure.capacity.container']),
      known('relevantEquipmentCodes', ['measure.equipment.power']),
      known('optionalNonpertinenceCodes', ['life.stage']),
    );
    const inputs = [candidate, f, [...byId]];
    const before = JSON.stringify(inputs);
    freeze(inputs);
    const result = project(candidate, f);
    expect(result).toEqual({
      relevantDimensionCodes: {
        codes: ['measure.dimensions.external_length'],
        toyTypes: [],
      },
      relevantFitCodes: ['measure.fit.neck'],
      relevantCapacityCodes: ['measure.capacity.container'],
      relevantEquipmentCodes: ['measure.equipment.power'],
      optionalNonpertinenceCodes: ['life.stage'],
    });
    result.relevantDimensionCodes!.codes.push('mutable');
    result.relevantDimensionCodes!.toyTypes.push('mutable');
    result.relevantDimensionCodes!.codes = [];
    for (const key of [
      'relevantFitCodes',
      'relevantCapacityCodes',
      'relevantEquipmentCodes',
      'optionalNonpertinenceCodes',
    ] as const)
      result[key]!.push('mutable');
    expect(JSON.stringify(inputs)).toBe(before);
    expect(project(candidate, f)).not.toEqual(result);
  });

  it('leaves frozen rejected inputs unchanged', () => {
    const candidate = row(known('relevantFitCodes', ['foreign']));
    const f = family('accessory');
    const before = JSON.stringify([candidate, f]);
    freeze([candidate, f]);
    expect(() => project(candidate, f)).toThrow('MALFORMED');
    expect(JSON.stringify([candidate, f])).toBe(before);
  });

  it('preserves shape-valid contradictions for later publication validation', () => {
    const candidate = row(
      known('fitDeterminesChoice', false),
      known('relevantFitCodes', ['measure.fit.neck']),
    );
    expect(project(candidate)).toEqual({
      fitDeterminesChoice: false,
      relevantFitCodes: ['measure.fit.neck'],
    });
  });

  it('does not introduce care completeness or value-evidence admission', () => {
    const candidate = row(known('presentationKind', 'formulation'));
    candidate.careReview = {
      state: 'prepared',
      jurisdiction: '',
      intendedUse: '',
      determination: 'none_applicable',
      evidence: [],
      basis: '',
      requirements: [],
      warnings: [],
    };
    expect(project(candidate, family('care'))).toEqual({
      presentationKind: 'formulation',
    });
  });

  it('feeds the real dispatcher evidenced negative N versus unknown U and S46 optional O', () => {
    const f = family('hygiene');
    const animal = f.bindings.find(
      (b) => b.definitionCode === 'animal.target',
    )!.policy;
    const dispatch = (facts: FactInputsV2, policy = animal, admitted = f) =>
      evaluateBindingPolicyV2(policy, admitted, [], null, facts);
    expect(dispatch(project(row(known('animalApplied', false)), f))).toEqual({
      applicability: 'not_applicable',
      required: false,
      allowNA: true,
      evidenceRequired: true,
      documentary: 'resolved',
    });
    expect(dispatch(project(row(unknown('animalApplied')), f))).toEqual({
      applicability: 'unresolved',
      required: false,
      allowNA: false,
      evidenceRequired: true,
      documentary: 'unresolved',
    });
    const accessory = family('accessory');
    const equipment = accessory.bindings.find(
      (b) => b.definitionCode === 'measure.equipment.power',
    )!.policy;
    const facts = project(
      row(
        unknown('electricalApplies'),
        known('relevantEquipmentCodes', ['measure.equipment.power']),
      ),
    );
    expect(dispatch(facts, equipment, accessory)).toEqual({
      applicability: 'applicable',
      required: false,
      allowNA: false,
      evidenceRequired: true,
      documentary: 'resolved',
    });
  });
});
