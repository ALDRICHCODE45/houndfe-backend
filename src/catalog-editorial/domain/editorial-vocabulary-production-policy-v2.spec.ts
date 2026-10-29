import { buildProductionVocabularyManifest } from '../../../prisma/editorial-production-vocabulary.manifest';
import { validateDefinitionV2 } from './editorial-vocabulary-definition-v2';
import { assertFamilyReferencesV2 } from './editorial-vocabulary-family-references-v2';
import {
  type BindingV2,
  type FamilyV2,
  parseFamilyShapeV2,
} from './editorial-vocabulary-family-shape-v2';
import { assertProductionBindingPoliciesV2 as assertPolicies } from './editorial-vocabulary-production-policy-v2';

const manifest = buildProductionVocabularyManifest();
const definitions = manifest.definitions.map((d, i) =>
  validateDefinitionV2({ ...d, id: `opaque-definition-${i}` }),
);
const byId = new Map(definitions.map((d) => [d.id, d]));
const ids = new Map(definitions.map((d) => [d.code, d.id]));
function candidate(code = 'food'): FamilyV2 {
  const source = manifest.families.find((f) => f.code === code)!;
  return parseFamilyShapeV2({
    ...source,
    id: 'opaque-family-id',
    label: 'Etiqueta propia',
    bindings: source.bindings.map((b) => ({
      ...b,
      definitionId: ids.get(b.definitionCode),
    })),
  });
}
function checked(family: FamilyV2): FamilyV2 {
  const parsed = parseFamilyShapeV2(family);
  assertFamilyReferencesV2(parsed, byId);
  return parsed;
}
function binding(family: FamilyV2, code = 'animal.target'): BindingV2 {
  return family.bindings.find((b) => b.definitionCode === code)!;
}
function freezeTree(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  Object.values(value).forEach(freezeTree);
  Object.freeze(value);
}
function rejects(family: FamilyV2): void {
  const parsed = checked(family);
  const before = structuredClone(parsed);
  freezeTree(parsed);
  expect(() => assertPolicies(parsed)).toThrow(TypeError);
  expect(parsed).toEqual(before);
}

describe('fresh production candidate binding policies V2', () => {
  it.each(manifest.families.map((f) => f.code))(
    'accepts exact %s independently without requiring the other six',
    (code) => {
      const family = checked(candidate(code));
      const before = structuredClone(family);
      freezeTree(family);
      expect(assertPolicies(family)).toBeUndefined();
      expect(family).toEqual(before);
    },
  );

  // Literal oracle independent of catalog expansion and manifest check-mode logic.
  it.each([
    ['food', 'measure.net_mass', 'content', 'always', 'FACET'],
    ['habitat', 'measure.net_mass', 'content', 'when_asserted', 'FACET'],
    [
      'toy',
      'measure.dimensions.external_width',
      'dimensions',
      'always',
      'FACET',
    ],
    ['habitat', 'measure.equipment.power', 'equipment', 'always', 'DETAIL'],
    [
      'accessory',
      'measure.equipment.power',
      'optional_equipment',
      'when_asserted',
      'DETAIL',
    ],
    [
      'care',
      'text.regulatory_warnings',
      'optional',
      'when_asserted',
      'INTERNAL',
    ],
    ['hygiene', 'hygiene.form', 'form', 'always', 'FACET'],
    ['care', 'pack.form', 'presentation', 'always', 'DETAIL'],
  ])(
    '%s / %s follows its literal route and exposure',
    (code, parameter, ruleId, check, exposure) => {
      const family = checked(candidate(code));
      const b = binding(family, parameter);
      expect(b).toMatchObject({
        owner: 'sellable',
        searchable: false,
        publicationCheck: check,
        exposure,
        policy: {
          route: 'fact_rule',
          rule: { family: code, parameter, ruleId },
        },
      });
      expect(assertPolicies(family)).toBeUndefined();
      b.publicationCheck = check === 'always' ? 'when_asserted' : 'always';
      rejects(family);
    },
  );

  it.each(['ruleId', 'family', 'parameter'] as const)(
    'rejects a wrong but existing %s',
    (key) => {
      const family = candidate();
      const policy = binding(family).policy;
      if (policy.route !== 'fact_rule') throw new Error('fixture');
      if (key === 'ruleId') policy.rule.ruleId = 'optional';
      if (key === 'family') policy.rule.family = 'treat';
      if (key === 'parameter') policy.rule.parameter = 'life.stage';
      rejects(family);
    },
  );

  it.each(['pending', 'option_cases'] as const)(
    'rejects mapped %s',
    (route) => {
      const family = candidate();
      binding(family).policy =
        route === 'pending' ? { route } : { route, cases: [] };
      rejects(family);
    },
  );

  it.each(['owner', 'version', 'exposure', 'searchable', 'publicationCheck'])(
    'rejects %s mismatch, including restrictive FACET to INTERNAL',
    (field) => {
      const family = candidate();
      const b = binding(family);
      if (field === 'owner') b.owner = 'product';
      if (field === 'version') family.minimumContractVersion = 1;
      if (field === 'exposure') b.exposure = 'INTERNAL';
      if (field === 'searchable') b.searchable = true;
      if (field === 'publicationCheck') b.publicationCheck = 'when_asserted';
      rejects(family);
    },
  );

  it('rejects missing bindings without filling inventory', () => {
    const family = candidate();
    family.bindings.pop();
    rejects(family);
  });

  it('rejects an extra valid definition outside this family', () => {
    const family = candidate();
    family.bindings.push(binding(candidate('toy'), 'toy.type'));
    rejects(family);
  });

  it('rejects a same-size replacement, not only a different count', () => {
    const family = candidate();
    family.bindings[0] = binding(candidate('toy'), 'toy.type');
    rejects(family);
  });

  it('preserves custom labels, opaque IDs, array identity and arbitrary ordering', () => {
    const family = candidate();
    family.bindings.reverse().forEach((b, i) => (b.sortOrder = -i));
    const parsed = checked(family);
    const bindings = parsed.bindings;
    const first = bindings[0];
    const before = structuredClone(parsed);
    freezeTree(parsed);
    expect(assertPolicies(parsed)).toBeUndefined();
    expect(parsed).toEqual(before);
    expect(parsed.bindings).toBe(bindings);
    expect(parsed.bindings[0]).toBe(first);
    expect(first.definitionId).not.toBe(first.definitionCode);
  });

  it.each(['pending', 'option_cases'] as const)(
    'leaves generic custom %s metadata outside the proof',
    (route) => {
      const family = candidate();
      family.code = 'food.extension';
      family.minimumContractVersion = 1;
      family.bindings = [binding(family)];
      const b = family.bindings[0];
      b.owner = 'product';
      b.exposure = 'DETAIL';
      b.searchable = true;
      b.policy =
        route === 'pending'
          ? { route }
          : {
              route,
              cases: [
                {
                  code: 'custom',
                  when: [],
                  applicability: 'unresolved',
                  required: false,
                  allowNA: true,
                  evidenceRequired: false,
                  documentary: 'unresolved',
                },
              ],
            };
      const parsed = checked(family);
      const before = structuredClone(parsed);
      freezeTree(parsed);
      expect(assertPolicies(parsed)).toBeUndefined();
      expect(parsed).toEqual(before);
    },
  );

  it('allows empty custom families without synthesizing production inventory', () => {
    const family = candidate();
    family.code = 'FOOD';
    family.bindings = [];
    const parsed = checked(family);
    freezeTree(parsed);
    expect(assertPolicies(parsed)).toBeUndefined();
    expect(parsed.bindings).toEqual([]);
  });

  it('allows custom definition codes and identities', () => {
    const d = validateDefinitionV2({
      id: 'custom-id',
      code: 'custom.text',
      label: 'Texto',
      type: 'text',
    });
    const family = candidate();
    family.code = 'custom';
    const b = binding(family);
    b.definitionId = d.id;
    b.definitionCode = d.code;
    b.policy = { route: 'pending' };
    family.bindings = [b];
    const parsed = parseFamilyShapeV2(family);
    assertFamilyReferencesV2(parsed, new Map([[d.id, d]]));
    freezeTree(parsed);
    expect(assertPolicies(parsed)).toBeUndefined();
  });

  it('rejects any borrowed fact_rule in a custom family', () => {
    const family = candidate();
    family.code = 'legacy';
    rejects(family);
  });
});
