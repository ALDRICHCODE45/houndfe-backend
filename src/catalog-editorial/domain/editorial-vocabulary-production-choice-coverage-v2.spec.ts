import { buildProductionVocabularyManifest } from '../../../prisma/editorial-production-vocabulary.manifest';
import { INVENTORY, OVERLAY } from './editorial-production-choice-inventory';
import { type ChoiceDefinitionV2 } from './editorial-vocabulary-choice-v2';
import {
  validateDefinitionV2,
  type DefinitionV2,
} from './editorial-vocabulary-definition-v2';
import { assertFamilyReferencesV2 } from './editorial-vocabulary-family-references-v2';
import { parseFamilyShapeV2 } from './editorial-vocabulary-family-shape-v2';
import { assertProductionChoiceCoverageV2 as assertCoverage } from './editorial-vocabulary-production-choice-coverage-v2';

const manifest = buildProductionVocabularyManifest();
function fixture(familyCode = 'hygiene') {
  const definitions = manifest.definitions.map((d, i) =>
    validateDefinitionV2({ ...d, id: `actual-definition-${i}` }),
  );
  const byId = new Map(definitions.map((d) => [d.id, d]));
  const source = manifest.families.find((f) => f.code === familyCode)!;
  const family = parseFamilyShapeV2({
    code: source.code,
    label: source.label,
    id: 'actual-family',
    bindings: source.bindings.map((b) => ({
      ...b,
      definitionId: definitions.find((d) => d.code === b.definitionCode)!.id,
    })),
  });
  assertFamilyReferencesV2(family, byId);
  return { family, byId };
}
function choice(byId: Map<string, DefinitionV2>, code: string) {
  return [...byId.values()].find((d) => d.code === code) as ChoiceDefinitionV2;
}
function revalidate(byId: Map<string, DefinitionV2>, d: DefinitionV2) {
  byId.set(d.id, validateDefinitionV2(d));
}
function withoutOption(d: ChoiceDefinitionV2, code: string) {
  d.options = d.options.filter((o) => o.code !== code);
  d.groups.forEach((g) => {
    g.optionCodes = g.optionCodes.filter((c) => c !== code);
  });
  d.aliases = d.aliases.filter((a) => a.optionCode !== code);
}
function snapshot(f: ReturnType<typeof fixture>) {
  return JSON.stringify([f.family, [...f.byId]]);
}

describe('assertProductionChoiceCoverageV2 (trusted candidates only)', () => {
  it.each(manifest.families.map((f) => f.code))(
    'accepts canonical coverage with actual IDs: %s',
    (code) => {
      const f = fixture(code);
      expect(assertCoverage(f.family, f.byId)).toBeUndefined();
    },
  );

  describe.each(INVENTORY)('%s / %s', (code, groupCode, _label, pairs) => {
    const familyCode = manifest.families.find((f) =>
      f.bindings.some((b) => b.definitionCode === code),
    )!.code;
    const firstPair = pairs.split('; ')[0];
    const optionCode = `${groupCode}.${firstPair.slice(0, firstPair.indexOf('='))}`;
    it.each(['option', 'group', 'membership'] as const)(
      'rejects missing canonical %s without mutating inputs',
      (missing) => {
        const f = fixture(familyCode);
        const d = choice(f.byId, code);
        if (missing === 'option') withoutOption(d, optionCode);
        if (missing === 'group')
          d.groups = d.groups.filter((g) => g.code !== groupCode);
        if (missing === 'membership') {
          const group = d.groups.find((g) => g.code === groupCode)!;
          group.optionCodes = group.optionCodes.filter((c) => c !== optionCode);
        }
        revalidate(f.byId, d);
        assertFamilyReferencesV2(f.family, f.byId);
        const before = snapshot(f);
        expect(() => assertCoverage(f.family, f.byId)).toThrow(TypeError);
        expect(snapshot(f)).toBe(before);
      },
    );
  });

  describe.each(OVERLAY)('S7 %s', (code) => {
    it.each(['option', 'membership'] as const)('requires %s', (missing) => {
      const f = fixture();
      const d = choice(f.byId, 'hygiene.form');
      if (missing === 'option') withoutOption(d, code);
      else {
        d.groups[0].optionCodes = d.groups[0].optionCodes.filter(
          (c) => c !== code,
        );
        // Membership elsewhere cannot replace membership in the first group.
        d.groups.push({ code: 'custom', label: 'Custom', optionCodes: [code] });
      }
      revalidate(f.byId, d);
      expect(() => assertCoverage(f.family, f.byId)).toThrow(TypeError);
    });
  });

  it('preserves archives, custom labels/order, aliases and overlapping extras', () => {
    const f = fixture();
    for (const d of f.byId.values()) {
      if (d.type !== 'single' && d.type !== 'multi') continue;
      d.label = `Custom ${d.code}`;
      d.options.reverse().forEach((o, i) => {
        o.archived = true;
        o.label = `Custom ${o.code}`;
        o.sortOrder = -i;
      });
      d.options.push({
        code: 'custom.extra',
        label: 'Extra',
        archived: false,
        sortOrder: -999,
      });
      d.groups.forEach((g) => {
        g.label = `Custom ${g.code}`;
        g.optionCodes.reverse().push('custom.extra');
      });
      d.groups.push({
        code: 'custom.group',
        label: 'Custom',
        optionCodes: d.options.map((o) => o.code),
      });
      d.groups.reverse();
      d.aliases.push({ label: 'Extra alias', optionCode: 'custom.extra' });
      revalidate(f.byId, d);
    }
    f.family.bindings.reverse();
    assertFamilyReferencesV2(f.family, f.byId);
    const before = snapshot(f);
    expect(assertCoverage(f.family, f.byId)).toBeUndefined();
    expect(snapshot(f)).toBe(before);
  });

  it('uses the bound actual ID rather than a complete code-keyed decoy', () => {
    const f = fixture();
    const d = choice(f.byId, 'hygiene.form');
    const decoy = validateDefinitionV2({
      ...d,
      id: d.code,
      code: 'custom.decoy',
    });
    f.byId.set(decoy.id, decoy);
    withoutOption(d, 'hygiene.form.bag');
    revalidate(f.byId, d);
    assertFamilyReferencesV2(f.family, f.byId);
    expect(() => assertCoverage(f.family, f.byId)).toThrow(TypeError);
  });

  it('does not inspect unbound canonical choice definitions', () => {
    const f = fixture('food');
    const d = choice(f.byId, 'hygiene.form');
    d.options = [];
    d.groups = [];
    revalidate(f.byId, d);
    expect(() => assertCoverage(f.family, f.byId)).not.toThrow();
  });

  it('retains generic semantics for custom families using canonical codes', () => {
    const f = fixture();
    const d = choice(f.byId, 'hygiene.form');
    d.options = [];
    d.groups = [];
    revalidate(f.byId, d);
    f.family = parseFamilyShapeV2({
      ...f.family,
      code: 'custom.family',
      bindings: f.family.bindings.map((b) => ({
        ...b,
        policy: { route: 'pending' },
      })),
    });
    assertFamilyReferencesV2(f.family, f.byId);
    expect(() => assertCoverage(f.family, f.byId)).not.toThrow();
  });

  it('composes the nonnumeric type assertion for non-choice definitions', () => {
    const f = fixture();
    const d = [...f.byId.values()].find((d) => d.code === 'text.instructions')!;
    f.byId.set(
      d.id,
      validateDefinitionV2({
        id: d.id,
        code: d.code,
        label: d.label,
        type: 'boolean',
      }),
    );
    expect(() => assertCoverage(f.family, f.byId)).toThrow(TypeError);
  });

  it('does not require approved alias coverage (separate future unit)', () => {
    const f = fixture();
    const d = choice(f.byId, 'animal.target');
    d.aliases = [];
    revalidate(f.byId, d);
    expect(() => assertCoverage(f.family, f.byId)).not.toThrow();
  });
});
