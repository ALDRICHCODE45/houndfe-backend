// Pure es-MX grouping of each production family's definitions for the editor form.
// Presentation only: not vocabulary semantics, never stored and never in a digest.
import type {
  ProductionDefinitionCode,
  ProductionFamily,
} from './editorial-production-vocabulary-catalog';

// One label per code, so a reused code means the same thing in every family.
export const SECTION_LABELS = Object.freeze({
  'para-quien': 'Para quién',
  'que-es': 'Qué es',
  caracteristicas: 'Características',
  formula: 'Fórmula',
  'medidas-ajuste': 'Talla y ajuste',
  medidas: 'Medidas',
  'equipo-electrico': 'Equipo eléctrico',
  'contenido-empaque': 'Contenido y empaque',
  uso: 'Uso',
} as const);

export type SectionCode = keyof typeof SECTION_LABELS;
export type ProductionSection = Readonly<{
  code: SectionCode;
  definitionCodes: readonly ProductionDefinitionCode[];
}>;

// Sections and their definitions are listed in display order.
function sections(
  ...rows: [SectionCode, ...ProductionDefinitionCode[]][]
): readonly ProductionSection[] {
  return Object.freeze(
    rows.map(([code, ...definitionCodes]) =>
      Object.freeze({ code, definitionCodes: Object.freeze(definitionCodes) }),
    ),
  );
}

const PACKAGE: ProductionDefinitionCode[] = [
  'content.kind',
  'measure.net_mass',
  'measure.net_volume',
  'measure.content_count',
  'measure.pack_count',
  'pack.form',
  'pack.sale',
];
// Same block with the coverage measures, which are content (rolls of bags…).
const PACKAGE_WITH_COVERAGE: ProductionDefinitionCode[] = [
  'content.kind',
  'measure.net_mass',
  'measure.net_volume',
  'measure.content_count',
  'measure.coverage.length',
  'measure.coverage.area',
  'measure.pack_count',
  'pack.form',
  'pack.sale',
];
const DIMENSIONS: ProductionDefinitionCode[] = [
  'measure.dimensions.external_length',
  'measure.dimensions.external_width',
  'measure.dimensions.external_height',
  'measure.dimensions.external_diameter',
  'measure.dimensions.internal_length',
  'measure.dimensions.internal_width',
  'measure.dimensions.internal_height',
  'measure.dimensions.internal_diameter',
];
const EQUIPMENT: ProductionDefinitionCode[] = [
  'measure.equipment.power',
  'measure.equipment.voltage',
  'measure.equipment.frequency',
  'measure.equipment.flow',
  'measure.equipment.temperature',
];
const FEATURES: ProductionDefinitionCode[] = [
  'feature.washable',
  'feature.reusable',
  'feature.waterproof',
];

// prettier-ignore
export const FAMILY_SECTIONS: Readonly<Record<ProductionFamily, readonly ProductionSection[]>> = Object.freeze({
  food: sections(
    ['para-quien', 'animal.target', 'life.stage', 'size.animal', 'measure.animal_mass'],
    ['que-es', 'food.format', 'food.role', 'food.texture', 'food.process', 'text.protein_origin', 'food.aquatic'],
    ['formula', 'text.ingredients', 'text.composition', 'text.clinical_analysis'],
    ['contenido-empaque', ...PACKAGE],
    ['uso', 'text.instructions'],
  ),
  treat: sections(
    ['para-quien', 'animal.target', 'life.stage', 'size.animal', 'measure.animal_mass'],
    ['que-es', 'treat.form', 'treat.base', 'food.texture', 'food.process', 'text.protein_origin'],
    ['formula', 'text.ingredients', 'text.composition', 'text.clinical_analysis'],
    ['contenido-empaque', ...PACKAGE],
    ['uso', 'text.instructions'],
  ),
  toy: sections(
    ['para-quien', 'animal.target', 'life.stage', 'size.animal', 'measure.animal_mass'],
    ['que-es', 'toy.type', 'material', 'color.base'],
    ['caracteristicas', 'toy.feature'],
    ['medidas', 'size.label', ...DIMENSIONS],
    ['contenido-empaque', ...PACKAGE],
    ['uso', 'text.instructions', 'text.manufacturer_care'],
  ),
  hygiene: sections(
    ['para-quien', 'animal.target', 'life.stage', 'measure.animal_mass'],
    ['que-es', 'hygiene.type', 'hygiene.form', 'hygiene.litter', 'hygiene.scent', 'material'],
    ['caracteristicas', ...FEATURES],
    ['medidas', ...DIMENSIONS],
    ['contenido-empaque', ...PACKAGE_WITH_COVERAGE],
    ['uso', 'text.instructions', 'text.manufacturer_care'],
  ),
  accessory: sections(
    ['para-quien', 'animal.target', 'life.stage', 'size.animal', 'measure.animal_mass'],
    ['que-es', 'accessory.type', 'material', 'color.base'],
    ['caracteristicas', 'accessory.closure', 'accessory.feature', ...FEATURES],
    ['medidas-ajuste', 'size.label', 'measure.fit.neck', 'measure.fit.chest', 'measure.fit.back_length'],
    ['medidas', ...DIMENSIONS, 'measure.capacity.container'],
    ['equipo-electrico', ...EQUIPMENT],
    ['contenido-empaque', ...PACKAGE],
    ['uso', 'text.instructions', 'text.manufacturer_care'],
  ),
  habitat: sections(
    ['para-quien', 'animal.target', 'life.stage', 'measure.animal_mass'],
    ['que-es', 'habitat.type', 'habitat.environment', 'habitat.substrate', 'material', 'color.base'],
    ['caracteristicas', 'habitat.component', ...FEATURES],
    ['medidas', ...DIMENSIONS, 'measure.capacity.container', 'measure.capacity.habitat_usable_volume'],
    ['equipo-electrico', ...EQUIPMENT],
    ['contenido-empaque', ...PACKAGE_WITH_COVERAGE],
    ['uso', 'text.instructions', 'text.manufacturer_care'],
  ),
  care: sections(
    ['para-quien', 'animal.target', 'life.stage', 'measure.animal_mass'],
    ['que-es', 'care.type', 'care.form', 'care.device'],
    ['formula', 'text.composition', 'text.concentration', 'text.clinical_analysis'],
    ['medidas', ...DIMENSIONS],
    ['contenido-empaque', ...PACKAGE],
    ['uso', 'text.instructions', 'text.manufacturer_care', 'text.regulatory_warnings'],
  ),
});
