import { buildProductionVocabularyManifest } from '../../../prisma/editorial-production-vocabulary.manifest';
import * as comparison from './editorial-alias-comparison-v1';
import { ALIASES } from './editorial-production-choice-inventory';
import type { ChoiceDefinitionV2 } from './editorial-vocabulary-choice-v2';
import { validateDefinitionV2 } from './editorial-vocabulary-definition-v2';
import { assertFamilyReferencesV2 } from './editorial-vocabulary-family-references-v2';
import { parseFamilyShapeV2 } from './editorial-vocabulary-family-shape-v2';
import { assertProductionAliasCoverageV2 as assertCoverage } from './editorial-vocabulary-production-alias-coverage-v2';

const manifest = buildProductionVocabularyManifest();
function fixture(familyCode = 'hygiene') {
  const definitions = manifest.definitions.map((d, i) =>
    validateDefinitionV2({ ...d, id: `actual-definition-${i}` }),
  );
  const byId = new Map(definitions.map((d) => [d.id, d]));
  const source = manifest.families.find((f) => f.code === familyCode)!;
  const family = parseFamilyShapeV2({
    ...source,
    id: 'actual-family',
    bindings: source.bindings.map((b) => ({
      ...b,
      definitionId: definitions.find((d) => d.code === b.definitionCode)!.id,
    })),
  });
  assertFamilyReferencesV2(family, byId);
  return { family, byId };
}
function animal(f: ReturnType<typeof fixture>) {
  return [...f.byId.values()].find(
    (d) => d.code === 'animal.target',
  ) as ChoiceDefinitionV2;
}
function revalidate(f: ReturnType<typeof fixture>, d = animal(f)) {
  f.byId.set(d.id, validateDefinitionV2(d));
  assertFamilyReferencesV2(f.family, f.byId);
}
function snapshot(f: ReturnType<typeof fixture>) {
  return JSON.stringify([f.family, [...f.byId]]);
}

describe('assertProductionAliasCoverageV2 (trusted candidates only)', () => {
  it.each(manifest.families.map((f) => f.code))(
    'accepts canonical aliases using actual IDs: %s',
    (code) => {
      const f = fixture(code);
      expect(assertCoverage(f.family, f.byId)).toBeUndefined();
    },
  );

  it.each(ALIASES)('requires explicit alias %s -> %s', (label) => {
    const f = fixture();
    const d = animal(f);
    d.aliases = d.aliases.filter((a) => a.label !== label);
    revalidate(f);
    const before = snapshot(f);
    expect(() => assertCoverage(f.family, f.byId)).toThrow(TypeError);
    expect(snapshot(f)).toBe(before);
  });

  it('rejects a validated wrong target even with the required label present', () => {
    const f = fixture();
    animal(f).aliases.find((a) => a.label === 'cuyo')!.optionCode =
      'ani.dom.dog';
    // Unlike cobaya/ninfa/asno, cuyo has no canonical option-label collision.
    revalidate(f);
    expect(() => assertCoverage(f.family, f.byId)).toThrow(TypeError);
  });

  it.each([
    ['cuyo', 'CUYO'],
    ['conejillo de Indias', '\u0085CÓNÉJÍLLO\u00a0\tDE\u2003ÍNDÍÁS\u3000'],
    ['carolina', '  CÁROLÍNA  '],
  ])(
    'accepts literal Unicode-equivalent explicit %s as %s',
    (label, equivalent) => {
      const f = fixture();
      animal(f).aliases.find((a) => a.label === label)!.label = equivalent;
      revalidate(f);
      const before = snapshot(f);
      expect(assertCoverage(f.family, f.byId)).toBeUndefined();
      expect(snapshot(f)).toBe(before);
    },
  );

  it('does not substitute the Cobaya option label for an explicit cobaya alias', () => {
    const f = fixture();
    const d = animal(f);
    expect(d.options.find((o) => o.code === 'ani.dom.guinea_pig')!.label).toBe(
      'Cobaya',
    );
    d.aliases = d.aliases.filter((a) => a.label !== 'cobaya');
    revalidate(f);
    expect(() => assertCoverage(f.family, f.byId)).toThrow(TypeError);
  });

  it('does not substitute an option code for an explicit alias entry', () => {
    const f = fixture();
    const d = animal(f);
    d.aliases = d.aliases.filter((a) => a.label !== 'cuyo');
    d.options.push({
      code: 'cuyo',
      label: 'Custom',
      archived: false,
      sortOrder: 0,
    });
    revalidate(f);
    expect(() => assertCoverage(f.family, f.byId)).toThrow(TypeError);
  });

  it('preserves valid extras, archived targets, submitted text and all ordering', () => {
    const f = fixture();
    const d = animal(f);
    d.options.reverse().forEach((o) => (o.archived = true));
    d.groups.reverse().forEach((g) => g.optionCodes.reverse());
    d.aliases.push({ label: 'Mi cobayita', optionCode: 'ani.dom.guinea_pig' });
    d.aliases.push({ label: 'CÚYO', optionCode: 'ani.dom.guinea_pig' });
    d.aliases.reverse();
    f.family.bindings.reverse();
    revalidate(f);
    const before = snapshot(f);
    expect(assertCoverage(f.family, f.byId)).toBeUndefined();
    expect(snapshot(f)).toBe(before);
  });

  it('resolves the bound actual ID, not a complete code-keyed decoy', () => {
    const f = fixture();
    const d = animal(f);
    const decoy = validateDefinitionV2({
      ...d,
      id: d.code,
      code: 'custom.decoy',
    });
    f.byId.set(decoy.id, decoy);
    d.aliases = [];
    revalidate(f);
    expect(() => assertCoverage(f.family, f.byId)).toThrow(TypeError);
  });

  it('ignores unbound choice definitions without approved aliases', () => {
    const f = fixture('food');
    const d = [...f.byId.values()].find(
      (d) => d.code === 'hygiene.form',
    ) as ChoiceDefinitionV2;
    d.options = [];
    d.groups = [];
    d.aliases = [];
    revalidate(f, d);
    expect(() => assertCoverage(f.family, f.byId)).not.toThrow();
  });

  it('retains generic semantics for custom families binding animal.target', () => {
    const f = fixture();
    animal(f).aliases = [];
    f.family = parseFamilyShapeV2({
      ...f.family,
      code: 'custom.family',
      minimumContractVersion: 1,
      bindings: f.family.bindings.map((b) => ({
        ...b,
        policy: { route: 'pending' },
      })),
    });
    revalidate(f);
    expect(() => assertCoverage(f.family, f.byId)).not.toThrow();
  });

  it('composes required choice coverage even when approved aliases are present', () => {
    const f = fixture();
    animal(f).groups = [];
    revalidate(f);
    expect(() => assertCoverage(f.family, f.byId)).toThrow(TypeError);
  });

  it('leaves different-target normalized collisions to the validator precondition', () => {
    const f = fixture();
    const d = animal(f);
    d.aliases.push({ label: 'CÚYO', optionCode: 'ani.dom.dog' });
    const before = snapshot(f);
    expect(() => revalidate(f)).toThrow('Expected a choice definition V2');
    expect(snapshot(f)).toBe(before);
  });

  it('imports harmlessly but propagates the comparator runtime failure unchanged at use', () => {
    const f = fixture();
    const descriptor = Object.getOwnPropertyDescriptor(
      process.versions,
      'unicode',
    )!;
    const original = comparison.editorialAliasComparisonKeyV1;
    let observed: unknown;
    const spy = jest
      .spyOn(comparison, 'editorialAliasComparisonKeyV1')
      .mockImplementation((input) => {
        try {
          return original(input);
        } catch (error) {
          observed = error;
          throw error;
        }
      });
    try {
      Object.defineProperty(process.versions, 'unicode', {
        ...descriptor,
        value: '16.0',
      });
      jest.isolateModules(() => {
        expect(() => {
          jest.requireActual(
            './editorial-vocabulary-production-alias-coverage-v2',
          );
        }).not.toThrow();
      });
      let caught: unknown;
      try {
        assertCoverage(f.family, f.byId);
      } catch (error) {
        caught = error;
      }
      expect(observed).toBeInstanceOf(Error);
      expect(caught).toBe(observed);
      expect((caught as Error).message).toBe(
        'collision-key-ucd17-v1 requires Unicode 17.0',
      );
    } finally {
      Object.defineProperty(process.versions, 'unicode', descriptor);
      spy.mockRestore();
    }
  });
});
