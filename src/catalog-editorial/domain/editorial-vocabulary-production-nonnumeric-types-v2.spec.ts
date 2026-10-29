import { buildProductionVocabularyManifest } from '../../../prisma/editorial-production-vocabulary.manifest';
import {
  validateDefinitionV2,
  type DefinitionV2,
} from './editorial-vocabulary-definition-v2';
import { assertFamilyReferencesV2 } from './editorial-vocabulary-family-references-v2';
import {
  parseFamilyShapeV2,
  type FamilyV2,
} from './editorial-vocabulary-family-shape-v2';
import { assertProductionNonnumericDefinitionTypesV2 as assertTypes } from './editorial-vocabulary-production-nonnumeric-types-v2';
import { assertProductionBindingPoliciesV2 } from './editorial-vocabulary-production-policy-v2';

const manifest = buildProductionVocabularyManifest();
// Independent documentary type oracle: normalized §3 and mapping §1, not catalog imports.
const oracle: [string, DefinitionV2['type']][] = [
  ...[
    'pack.form',
    'pack.sale',
    'content.kind',
    'size.label',
    'food.format',
    'food.role',
    'food.aquatic',
    'treat.form',
    'hygiene.type',
    'hygiene.form',
    'hygiene.scent',
    'accessory.type',
    'habitat.type',
    'care.type',
    'care.form',
    'care.device',
  ].map((code): [string, 'single'] => [code, 'single']),
  ...[
    'animal.target',
    'life.stage',
    'material',
    'color.base',
    'size.animal',
    'food.process',
    'food.texture',
    'treat.base',
    'toy.type',
    'toy.feature',
    'hygiene.litter',
    'accessory.closure',
    'accessory.feature',
    'habitat.environment',
    'habitat.substrate',
    'habitat.component',
  ].map((code): [string, 'multi'] => [code, 'multi']),
  ...[
    'text.ingredients',
    'text.protein_origin',
    'text.composition',
    'text.manufacturer_care',
    'text.instructions',
    'text.clinical_analysis',
    'text.concentration',
    'text.regulatory_warnings',
  ].map((code): [string, 'text'] => [code, 'text']),
  ...['feature.washable', 'feature.reusable', 'feature.waterproof'].map(
    (code): [string, 'boolean'] => [code, 'boolean'],
  ),
];
function fixture(code = 'food') {
  const definitions = manifest.definitions.map((d, i) =>
    validateDefinitionV2({ ...d, id: `actual-definition-${i}` }),
  );
  const byId = new Map(definitions.map((d) => [d.id, d]));
  const ids = new Map(definitions.map((d) => [d.code, d.id]));
  const source = manifest.families.find((f) => f.code === code)!;
  const family = parseFamilyShapeV2({
    ...source,
    id: 'actual-family',
    bindings: source.bindings.map((b) => ({
      ...b,
      definitionId: ids.get(b.definitionCode),
    })),
  });
  return { family, byId };
}
function definition(byId: Map<string, DefinitionV2>, code: string) {
  return [...byId.values()].find((d) => d.code === code)!;
}
function replace(
  byId: Map<string, DefinitionV2>,
  code: string,
  type: DefinitionV2['type'],
) {
  const d = definition(byId, code);
  byId.set(
    d.id,
    validateDefinitionV2({
      id: d.id,
      code,
      label: d.label,
      type,
      ...(['single', 'multi'].includes(type)
        ? { options: [], groups: [], aliases: [] }
        : {}),
      ...(['number', 'range'].includes(type)
        ? { units: [], numericPolicy: { status: 'pending' } }
        : {}),
    }),
  );
}
function freezeTree(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  Object.values(value).forEach(freezeTree);
  Object.freeze(value);
}
function run(
  family: FamilyV2,
  byId: Map<string, DefinitionV2>,
  reject = false,
) {
  const parsed = parseFamilyShapeV2(family);
  const validated = new Map(
    [...byId].map(([id, d]) => [id, validateDefinitionV2(d)]),
  );
  assertFamilyReferencesV2(parsed, validated);
  const before = structuredClone({ parsed, entries: [...validated] });
  freezeTree(parsed);
  validated.forEach(freezeTree);
  Object.freeze(validated);
  if (reject) expect(() => assertTypes(parsed, validated)).toThrow(TypeError);
  else expect(assertTypes(parsed, validated)).toBeUndefined();
  expect({ parsed, entries: [...validated] }).toEqual(before);
}

describe('fresh production nonnumeric definition types V2', () => {
  it('accepts all 43 documentary types across all seven reference-checked families', () => {
    const seen = new Set<string>();
    expect(oracle).toHaveLength(43);
    expect(new Set(oracle.map(([code]) => code)).size).toBe(43);
    for (const code of [
      'food',
      'treat',
      'toy',
      'hygiene',
      'accessory',
      'habitat',
      'care',
    ]) {
      const { family, byId } = fixture(code);
      for (const [parameter, type] of oracle) {
        if (!family.bindings.some((b) => b.definitionCode === parameter))
          continue;
        expect(definition(byId, parameter).type).toBe(type);
        seen.add(parameter);
      }
      run(family, byId);
    }
    expect(seen.size).toBe(43);
  });

  it.each(oracle)(
    'rejects a wrong canonical type for %s (%s)',
    (code, type) => {
      const familyCode = manifest.families.find((f) =>
        f.bindings.some((b) => b.definitionCode === code),
      )!.code;
      const { family, byId } = fixture(familyCode);
      const wrong = {
        single: 'multi',
        multi: 'single',
        text: 'boolean',
        boolean: 'text',
      } as const;
      if (type === 'number' || type === 'range') throw new Error('oracle');
      replace(byId, code, wrong[type]);
      run(family, byId, true);
    },
  );

  it.each(['text', 'number', 'range'] as const)(
    'rejects choice replaced by %s',
    (type) => {
      const { family, byId } = fixture();
      replace(byId, 'animal.target', type);
      run(family, byId, true);
    },
  );

  it('preserves valid labels/order/aliases/archive/groups and additional option members', () => {
    const { family, byId } = fixture();
    family.label = 'Familia propia';
    family.bindings.reverse();
    family.bindings[0].sortOrder = -37;
    const d = definition(byId, 'animal.target');
    if (d.type !== 'multi') throw new Error('fixture');
    d.label = 'Destinatarios declarados';
    d.options.reverse();
    d.options[0].archived = true;
    d.options[0].label = 'Etiqueta propia';
    d.options[0].sortOrder = -7;
    d.options.push({
      code: 'custom.member',
      label: 'Miembro adicional',
      archived: false,
      sortOrder: 93,
    });
    d.groups.push({
      code: 'custom.group',
      label: 'Grupo propio',
      optionCodes: ['custom.member'],
    });
    d.aliases.push({ label: 'Alias propio', optionCode: 'custom.member' });
    run(family, byId);
  });

  it.each(['single', 'multi', 'text', 'boolean', 'number', 'range'] as const)(
    'leaves generic %s semantics in custom families unchanged',
    (type) => {
      const { family, byId } = fixture();
      family.code = 'custom';
      family.minimumContractVersion = 1;
      family.bindings = family.bindings.filter(
        (b) => b.definitionCode === 'animal.target',
      );
      family.bindings[0].policy = { route: 'pending' };
      replace(byId, 'animal.target', type);
      run(family, byId);
    },
  );

  it.each(['text', 'number'] as const)(
    'does not check numeric metadata (received as %s) or unbound definitions',
    (type) => {
      const { family, byId } = fixture();
      replace(byId, 'measure.net_mass', type);
      replace(byId, 'care.type', 'boolean');
      run(family, byId);
    },
  );

  it('propagates binding-policy failure unchanged before definition lookup', () => {
    const { family, byId } = fixture();
    family.bindings[0].policy = { route: 'pending' };
    byId.clear(); // Deliberate precondition breach to prove composition order.
    let expected: unknown;
    try {
      assertProductionBindingPoliciesV2(family);
    } catch (error) {
      expected = error;
    }
    expect(expected).toBeInstanceOf(TypeError);
    expect(() => assertTypes(family, byId)).toThrow(expected as Error);
  });

  it.each(['missing ID', 'wrong resolved code'])(
    'guards %s (deliberate reference precondition breach)',
    (mutation) => {
      const { family, byId } = fixture();
      const d = definition(byId, 'animal.target');
      if (mutation === 'missing ID') byId.delete(d.id);
      else d.code = 'wrong.code';
      const before = structuredClone({ family, entries: [...byId] });
      freezeTree(family);
      byId.forEach(freezeTree);
      expect(() => assertTypes(family, byId)).toThrow(TypeError);
      expect({ family, entries: [...byId] }).toEqual(before);
    },
  );
});
