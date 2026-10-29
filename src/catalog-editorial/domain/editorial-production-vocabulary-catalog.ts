// Pure production membership and normative rows; no provisioning or policy admission.
export const FAMILY_CODES = Object.freeze([
  'food',
  'treat',
  'toy',
  'hygiene',
  'accessory',
  'habitat',
  'care',
] as const);
export type ProductionFamily = (typeof FAMILY_CODES)[number];
const RULE_IDS = Object.freeze([
  'required',
  'optional',
  'animal',
  'form',
  'content',
  'dimensions',
  'fit',
  'capacity',
  'space',
  'equipment',
  'optional_equipment',
  'presentation',
] as const);
export type RuleId = (typeof RULE_IDS)[number];

// Rows contain only primitives; freeze both levels while retaining literal inference.
function freezeRows<const T extends readonly (readonly string[])[]>(
  rows: T,
): T {
  rows.forEach(Object.freeze);
  return Object.freeze(rows);
}

// code, type, exposure, disjoint family:rule routes (mapping §1).
// prettier-ignore
export const CHOICES = freezeRows([
  ['animal.target', 'multi', 'F', 'food:required,treat:required,toy:required,hygiene:animal,accessory:optional,habitat:optional,care:optional'],
  ['life.stage', 'multi', 'F', 'ALL:optional'],
  ['pack.form', 'single', 'D', 'food:optional,treat:optional,toy:optional,hygiene:optional,accessory:optional,habitat:optional,care:presentation'],
  ['pack.sale', 'single', 'D', 'ALL:optional'],
  ['content.kind', 'single', 'D', 'ALL:optional'],
  ['material', 'multi', 'F', 'toy:optional,hygiene:optional,accessory:optional,habitat:optional'],
  ['color.base', 'multi', 'F', 'toy:optional,accessory:optional,habitat:optional'],
  ['size.label', 'single', 'F', 'toy:optional,accessory:optional'],
  ['size.animal', 'multi', 'F', 'food:optional,treat:optional,toy:optional,accessory:optional'],
  ['food.format', 'single', 'F', 'food:required'],
  ['food.role', 'single', 'F', 'food:optional'],
  ['food.process', 'multi', 'D', 'food:optional,treat:optional'],
  ['food.texture', 'multi', 'F', 'food:optional,treat:optional'],
  ['food.aquatic', 'single', 'F', 'food:optional'],
  ['treat.form', 'single', 'F', 'treat:required'],
  ['treat.base', 'multi', 'D', 'treat:optional'],
  ['toy.type', 'multi', 'F', 'toy:required'],
  ['toy.feature', 'multi', 'F', 'toy:optional'],
  ['hygiene.type', 'single', 'F', 'hygiene:required'],
  ['hygiene.form', 'single', 'F', 'hygiene:form'],
  ['hygiene.litter', 'multi', 'F', 'hygiene:optional'],
  ['hygiene.scent', 'single', 'D', 'hygiene:optional'],
  ['accessory.type', 'single', 'F', 'accessory:required'],
  ['accessory.closure', 'multi', 'D', 'accessory:optional'],
  ['accessory.feature', 'multi', 'F', 'accessory:optional'],
  ['habitat.type', 'single', 'F', 'habitat:required'],
  ['habitat.environment', 'multi', 'F', 'habitat:optional'],
  ['habitat.substrate', 'multi', 'F', 'habitat:optional'],
  ['habitat.component', 'multi', 'F', 'habitat:optional'],
  ['care.type', 'single', 'F', 'care:required'],
  ['care.form', 'single', 'F', 'care:presentation'],
  ['care.device', 'single', 'D', 'care:presentation'],
] as const);

// Expanded numeric codes in normative order. P=positive real, I=positive integer,
// F=finite unbounded real (including U07 fit and U08 equipment).
// prettier-ignore
export const NUMBERS = freezeRows([
  ['measure.net_mass', 'number', 'mg,g,kg', 'F', 'P', 'ALL:content'],
  ['measure.net_volume', 'number', 'ml,l', 'F', 'P', 'ALL:content'],
  ['measure.content_count', 'number', 'piece,dose_unit,sheet,roll', 'D', 'I', 'ALL:content'],
  ['measure.pack_count', 'number', 'unit', 'D', 'I', 'ALL:optional'],
  ['measure.dimensions.external_length', 'number', 'mm,cm,m', 'F', 'P', 'toy:dimensions,hygiene:optional,accessory:optional,habitat:space,care:optional'],
  ['measure.dimensions.external_width', 'number', 'mm,cm,m', 'F', 'P', 'toy:dimensions,hygiene:optional,accessory:optional,habitat:space,care:optional'],
  ['measure.dimensions.external_height', 'number', 'mm,cm,m', 'F', 'P', 'toy:dimensions,hygiene:optional,accessory:optional,habitat:space,care:optional'],
  ['measure.dimensions.external_diameter', 'number', 'mm,cm,m', 'F', 'P', 'toy:dimensions,hygiene:optional,accessory:optional,habitat:space,care:optional'],
  ['measure.dimensions.internal_length', 'number', 'mm,cm,m', 'F', 'P', 'toy:dimensions,hygiene:optional,accessory:optional,habitat:space,care:optional'],
  ['measure.dimensions.internal_width', 'number', 'mm,cm,m', 'F', 'P', 'toy:dimensions,hygiene:optional,accessory:optional,habitat:space,care:optional'],
  ['measure.dimensions.internal_height', 'number', 'mm,cm,m', 'F', 'P', 'toy:dimensions,hygiene:optional,accessory:optional,habitat:space,care:optional'],
  ['measure.dimensions.internal_diameter', 'number', 'mm,cm,m', 'F', 'P', 'toy:dimensions,hygiene:optional,accessory:optional,habitat:space,care:optional'],
  ['measure.fit.neck', 'range', 'cm,mm', 'F', 'F', 'accessory:fit'],
  ['measure.fit.chest', 'range', 'cm,mm', 'F', 'F', 'accessory:fit'],
  ['measure.fit.back_length', 'range', 'cm,mm', 'F', 'F', 'accessory:fit'],
  ['measure.animal_mass', 'range', 'g,kg', 'F', 'P', 'ALL:optional'],
  ['measure.capacity.container', 'number', 'ml,l', 'F', 'P', 'accessory:capacity,habitat:space'],
  ['measure.capacity.habitat_usable_volume', 'number', 'ml,l', 'F', 'P', 'habitat:space'],
  ['measure.equipment.power', 'number', 'W', 'D', 'F', 'accessory:optional_equipment,habitat:equipment'],
  ['measure.equipment.voltage', 'number', 'V', 'D', 'F', 'accessory:optional_equipment,habitat:equipment'],
  ['measure.equipment.frequency', 'number', 'Hz', 'D', 'F', 'accessory:optional_equipment,habitat:equipment'],
  ['measure.equipment.flow', 'number', 'l/h', 'D', 'F', 'accessory:optional_equipment,habitat:equipment'],
  ['measure.equipment.temperature', 'range', '°C', 'D', 'F', 'accessory:optional_equipment,habitat:equipment'],
  ['measure.coverage.length', 'number', 'm', 'D', 'P', 'hygiene:content,habitat:content'],
  ['measure.coverage.area', 'number', 'm²', 'D', 'P', 'hygiene:content,habitat:content'],
] as const);
// prettier-ignore
export const OTHER = freezeRows([
  ['text.ingredients', 'text', 'food,treat', 'D'],
  ['text.protein_origin', 'text', 'food,treat', 'D'],
  ['text.composition', 'text', 'food,treat,care', 'D'],
  ['text.manufacturer_care', 'text', 'toy,hygiene,accessory,habitat,care', 'D'],
  ['text.instructions', 'text', 'ALL', 'D'],
  ['text.clinical_analysis', 'text', 'food,treat,care', 'I'],
  ['text.concentration', 'text', 'care', 'I'],
  ['text.regulatory_warnings', 'text', 'care', 'I'],
  ['feature.washable', 'boolean', 'hygiene,accessory,habitat', 'D'],
  ['feature.reusable', 'boolean', 'hygiene,accessory,habitat', 'D'],
  ['feature.waterproof', 'boolean', 'hygiene,accessory,habitat', 'D'],
] as const);
export type ProductionDefinitionCode =
  | (typeof CHOICES)[number][0]
  | (typeof NUMBERS)[number][0]
  | (typeof OTHER)[number][0];
export type ChoiceCode = (typeof CHOICES)[number][0];

const definitionCodes = new Set<string>(
  [...CHOICES, ...NUMBERS, ...OTHER].map(([code]) => code),
);
const families = new Set<string>(FAMILY_CODES);
const ruleIds = new Set<string>(RULE_IDS);

export function isProductionDefinitionCode(
  value: unknown,
): value is ProductionDefinitionCode {
  return typeof value === 'string' && definitionCodes.has(value);
}
export function isProductionFamily(value: unknown): value is ProductionFamily {
  return typeof value === 'string' && families.has(value);
}
export function isProductionRuleId(value: unknown): value is RuleId {
  return typeof value === 'string' && ruleIds.has(value);
}
