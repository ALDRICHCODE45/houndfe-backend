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
import type { NumericDefinitionV2 } from './editorial-vocabulary-numeric-v2';
import { assertProductionNumericDefinitionsV2 as assertNumeric } from './editorial-vocabulary-production-numeric-v2';

const manifest = buildProductionVocabularyManifest();
// Independent documentary oracle: mapping §1 / wire §7, not catalog-derived.
const oracle = [
  ['measure.net_mass', 'number', 'mg,g,kg', 'P'],
  ['measure.net_volume', 'number', 'ml,l', 'P'],
  ['measure.content_count', 'number', 'piece,dose_unit,sheet,roll', 'I'],
  ['measure.pack_count', 'number', 'unit', 'I'],
  ...['external', 'internal'].flatMap((side) =>
    ['length', 'width', 'height', 'diameter'].map((axis) => [
      `measure.dimensions.${side}_${axis}`,
      'number',
      'mm,cm,m',
      'P',
    ]),
  ),
  ...['neck', 'chest', 'back_length'].map((axis) => [
    `measure.fit.${axis}`,
    'range',
    'cm,mm',
    'F',
  ]),
  ['measure.animal_mass', 'range', 'g,kg', 'P'],
  ['measure.capacity.container', 'number', 'ml,l', 'P'],
  ['measure.capacity.habitat_usable_volume', 'number', 'ml,l', 'P'],
  ['measure.equipment.power', 'number', 'W', 'F'],
  ['measure.equipment.voltage', 'number', 'V', 'F'],
  ['measure.equipment.frequency', 'number', 'Hz', 'F'],
  ['measure.equipment.flow', 'number', 'l/h', 'F'],
  ['measure.equipment.temperature', 'range', '°C', 'F'],
  ['measure.coverage.length', 'number', 'm', 'P'],
  ['measure.coverage.area', 'number', 'm²', 'P'],
];
function fixture(familyCode = 'accessory') {
  const definitions = manifest.definitions.map((d, i) =>
    validateDefinitionV2({ ...d, id: `actual-id-${i}` }),
  );
  const byId = new Map(definitions.map((d) => [d.id, d]));
  const ids = new Map(definitions.map((d) => [d.code, d.id]));
  const source = manifest.families.find((f) => f.code === familyCode)!;
  const family = parseFamilyShapeV2({
    code: source.code,
    label: source.label,
    id: 'actual-family-id',
    bindings: source.bindings.map((b) => ({
      ...b,
      definitionId: ids.get(b.definitionCode),
    })),
  });
  return { family, byId };
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
  if (reject) expect(() => assertNumeric(parsed, validated)).toThrow(TypeError);
  else expect(assertNumeric(parsed, validated)).toBeUndefined();
  expect({ parsed, entries: [...validated] }).toEqual(before);
}
function numeric(byId: Map<string, DefinitionV2>, code = 'measure.net_mass') {
  return [...byId.values()].find((d) => d.code === code) as NumericDefinitionV2;
}

describe('fresh production numeric definitions V2', () => {
  it.each(['food', 'treat', 'toy', 'hygiene', 'accessory', 'habitat', 'care'])(
    'accepts %s with actual IDs and checks every bound documentary row',
    (code) => {
      const { family, byId } = fixture(code);
      expect(oracle).toHaveLength(25);
      for (const [parameter, type, units, domain] of oracle) {
        if (!family.bindings.some((b) => b.definitionCode === parameter))
          continue;
        const d = numeric(byId, parameter);
        expect(d.type).toBe(type);
        expect(d.units.map((u) => u.code).sort()).toEqual(
          units.split(',').sort(),
        );
        expect(d.numericPolicy).toEqual({
          status: 'resolved',
          magnitude: parameter,
          integer: domain === 'I',
          lower: domain === 'F' ? null : 0,
          lowerInclusive: false,
          upper: null,
          upperInclusive: false,
        });
      }
      run(family, byId);
    },
  );

  it.each(oracle)('rejects wrong numeric type for %s', (code, type) => {
    const familyCode =
      code.startsWith('measure.coverage') ||
      code.endsWith('habitat_usable_volume')
        ? 'habitat'
        : 'accessory';
    const { family, byId } = fixture(familyCode);
    numeric(byId, code).type = type === 'number' ? 'range' : 'number';
    run(family, byId, true);
  });

  it.each(['text', 'boolean', 'single', 'multi'] as const)(
    'does not skip a bound numeric code received as %s',
    (type) => {
      const { family, byId } = fixture();
      const d = numeric(byId);
      byId.set(
        d.id,
        validateDefinitionV2({
          id: d.id,
          code: d.code,
          label: d.label,
          type,
          ...(['single', 'multi'].includes(type)
            ? { options: [], groups: [], aliases: [] }
            : {}),
        }),
      );
      run(family, byId, true);
    },
  );

  it.each([
    { status: 'pending' },
    { magnitude: 'different' },
    { integer: true },
    { lower: null },
    { lower: -1 },
    { lower: 1 },
    { lowerInclusive: true },
    { upper: 100 },
    { upper: 100, upperInclusive: true },
  ])('rejects nonnormative policy %j', (patch) => {
    const { family, byId } = fixture();
    const d = numeric(byId);
    d.numericPolicy =
      patch.status === 'pending'
        ? { status: 'pending' }
        : ({
            ...d.numericPolicy,
            ...patch,
          } as NumericDefinitionV2['numericPolicy']);
    run(family, byId, true);
  });

  it.each([
    'measure.content_count',
    'measure.pack_count',
    'measure.fit.neck',
    'measure.equipment.power',
    'measure.animal_mass',
  ])('protects integer/positive/unbounded classification for %s', (code) => {
    const { family, byId } = fixture();
    const d = numeric(byId, code);
    if (d.numericPolicy.status !== 'resolved') throw new Error('fixture');
    if (code.includes('count')) d.numericPolicy.integer = false;
    else d.numericPolicy.lower = d.numericPolicy.lower === null ? 0 : null;
    run(family, byId, true);
  });

  it.each(['empty', 'missing', 'extra', 'null', 'alias', 'case'])(
    'rejects %s units without normalization',
    (mutation) => {
      const { family, byId } = fixture();
      const d = numeric(
        byId,
        mutation === 'alias'
          ? 'measure.equipment.temperature'
          : 'measure.net_mass',
      );
      if (mutation === 'empty') d.units = [];
      if (mutation === 'missing') d.units.pop();
      if (mutation === 'extra')
        d.units.push({ code: 'lb', label: 'Libra', sortOrder: 99 });
      if (mutation === 'null')
        d.units[0] = { code: null, label: null, sortOrder: 0 };
      if (mutation === 'alias') d.units[0].code = 'degC';
      if (mutation === 'case') d.units[0].code = 'MG';
      run(family, byId, true);
    },
  );

  it('preserves reordered units, labels, IDs and arbitrary valid sortOrders', () => {
    const { family, byId } = fixture();
    family.label = 'Familia propia';
    family.bindings.reverse();
    const d = numeric(byId);
    d.label = 'Masa declarada';
    d.units.reverse().forEach((u, i) => {
      u.label = `Unidad ${i}`;
      u.sortOrder = 20 - i;
    });
    run(family, byId);
  });

  it('leaves generic pending/null-unit semantics in custom families alone', () => {
    const { family, byId } = fixture();
    family.code = 'custom';
    family.bindings = family.bindings.filter(
      (b) => b.definitionCode === 'measure.net_mass',
    );
    family.bindings[0].policy = { route: 'pending' };
    const d = numeric(byId);
    d.numericPolicy = { status: 'pending' };
    d.units = [{ code: null, label: null, sortOrder: -1 }];
    run(family, byId);
  });

  it('ignores unbound definitions', () => {
    const { family, byId } = fixture('food');
    numeric(byId, 'measure.equipment.power').numericPolicy = {
      status: 'pending',
    };
    run(family, byId);
  });

  it.each(['missing', 'extra', 'policy'])(
    'composes binding assertion first: %s failure propagates unchanged',
    (mutation) => {
      const { family, byId } = fixture();
      if (mutation === 'missing') family.bindings.pop();
      if (mutation === 'extra') {
        const d = validateDefinitionV2({
          id: 'extra-id',
          code: 'custom',
          label: 'Custom',
          type: 'text',
        });
        byId.set(d.id, d);
        family.bindings.push({
          ...family.bindings[0],
          definitionId: d.id,
          definitionCode: d.code,
        });
      }
      if (mutation === 'policy')
        family.bindings[0].policy = { route: 'pending' };
      numeric(byId).numericPolicy = { status: 'pending' };
      expect(() => assertNumeric(parseFamilyShapeV2(family), byId)).toThrow(
        'Expected production binding policies V2',
      );
      run(family, byId, true);
    },
  );

  it('rejects a mismatching resolved definition code rather than trusting map keys', () => {
    const { family, byId } = fixture();
    numeric(byId).code = 'wrong';
    // Deliberate precondition breach: ordinary paths above use reference validation.
    expect(() => assertNumeric(family, byId)).toThrow(TypeError);
  });
});
