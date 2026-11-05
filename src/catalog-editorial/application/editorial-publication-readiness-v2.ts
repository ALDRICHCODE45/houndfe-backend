import { isProductionFamily } from '../domain/editorial-production-vocabulary-catalog';
import { DEFINITION_LABELS } from '../domain/editorial-production-vocabulary-labels';
import {
  FAMILY_SECTIONS,
  type SectionCode,
} from '../domain/editorial-production-vocabulary-sections';
import type { PublicationProblemV2 } from '../domain/editorial-publication-readiness-v2';

export type ReadinessItemV2 = {
  scope: PublicationProblemV2['scope'];
  definitionCode: string | null;
  variantId: string | null;
  sectionCode: SectionCode | null;
  problem: PublicationProblemV2['problem'];
  message: string;
};
export type ReadinessV2 = {
  ready: boolean;
  cycle: number | null;
  draftRevision: number | null;
  vocabularyRevision: string;
  items: ReadinessItemV2[];
  bySection: Partial<Record<SectionCode, number>>;
};

// Human copy in neutral Mexican Spanish with «tú». Codes stay the logic contract.
export const READINESS_MESSAGES: Readonly<
  Record<'definition' | 'variant' | 'product' | 'care', Record<string, string>>
> = Object.freeze({
  definition: {
    UNRESOLVED:
      'Responde las preguntas de la presentación para saber si este dato aplica.',
    EVIDENCE_REQUIRED: 'Agrega de dónde sale este dato.',
    NA_NOT_ALLOWED: 'Este dato sí aplica: no lo marques como «No aplica».',
    NOT_APPLICABLE_VALUE: 'Este dato no aplica a este producto; quítalo.',
    MAGNITUDE_MISMATCH:
      'El tipo de contenido no coincide con cómo se mide el contenido de la presentación.',
    TOY_TYPES_MISMATCH:
      'Las medidas de la presentación deben cubrir exactamente los tipos de juguete elegidos.',
    NUMERIC_POLICY_PENDING:
      'Este dato todavía no tiene reglas de captura; pide a un administrador que las defina.',
    INVALID_VALUE: 'Revisa este valor: está fuera del rango permitido.',
    ARCHIVED_OPTION: 'Esta opción ya no está disponible; elige otra.',
  },
  variant: {
    FACTS_CONFLICT:
      'Hay respuestas que se contradicen en las preguntas de esta presentación.',
  },
  product: {
    commercialTitle: 'Falta el título comercial.',
    familyCode: 'Elige el tipo de producto.',
    MEDIA_NOT_ALLOWED: 'Quita las imágenes: todavía no se pueden publicar.',
    NO_OFFERED_PRESENTATION:
      'El producto no se ofrece en ninguna lista de precios en línea.',
    DRAFT_INVALID:
      'Tu borrador ya no coincide con el producto o el vocabulario actual; revísalo y guárdalo de nuevo.',
    NO_DRAFT:
      'Todavía no hay un borrador guardado; guarda tus cambios para revisar qué falta.',
  },
  care: {
    REVIEW_MISSING: 'Completa la revisión de cuidado de esta presentación.',
    REVIEW_EVIDENCE_MISSING: 'Agrega de dónde sale la revisión de cuidado.',
    NONE_APPLICABLE_HAS_ENTRIES:
      'Si no aplica ningún requisito, quita los requisitos y las advertencias de la revisión.',
    REQUIREMENTS_MISSING:
      'Agrega al menos un requisito a la revisión de cuidado.',
    REQUIREMENT_OPEN:
      'Resuelve cada requisito de cuidado y agrega de dónde sale.',
    WARNING_PUBLIC:
      'Hay una advertencia que se debe mostrar al público; por ahora no se puede publicar.',
    WARNING_OPEN:
      'Indica cómo se maneja cada advertencia y agrega de dónde sale.',
  },
});

type Article = 'el' | 'la' | 'los' | 'las';
// Article of each shipped production label; adjectives (feature.*) get the quoted form.
// prettier-ignore
const ARTICLES: Readonly<Record<string, Article>> = Object.freeze({
  'animal.target': 'la', 'life.stage': 'la', 'pack.form': 'el', 'pack.sale': 'el',
  'content.kind': 'el', 'material': 'el', 'color.base': 'el', 'size.label': 'la',
  'size.animal': 'el', 'food.format': 'el', 'food.role': 'la', 'food.process': 'el',
  'food.texture': 'la', 'food.aquatic': 'el', 'treat.form': 'la', 'treat.base': 'la',
  'toy.type': 'el', 'toy.feature': 'las', 'hygiene.type': 'el', 'hygiene.form': 'la',
  'hygiene.litter': 'la', 'hygiene.scent': 'la', 'accessory.type': 'el',
  'accessory.closure': 'el', 'accessory.feature': 'las', 'habitat.type': 'el',
  'habitat.environment': 'el', 'habitat.substrate': 'el', 'habitat.component': 'los',
  'care.type': 'el', 'care.form': 'la', 'care.device': 'el',
  'measure.net_mass': 'el', 'measure.net_volume': 'el', 'measure.content_count': 'la',
  'measure.pack_count': 'las',
  'measure.dimensions.external_length': 'el', 'measure.dimensions.external_width': 'el',
  'measure.dimensions.external_height': 'el', 'measure.dimensions.external_diameter': 'el',
  'measure.dimensions.internal_length': 'el', 'measure.dimensions.internal_width': 'el',
  'measure.dimensions.internal_height': 'el', 'measure.dimensions.internal_diameter': 'el',
  'measure.fit.neck': 'el', 'measure.fit.chest': 'el', 'measure.fit.back_length': 'el',
  'measure.animal_mass': 'el', 'measure.capacity.container': 'la',
  'measure.capacity.habitat_usable_volume': 'el', 'measure.equipment.power': 'la',
  'measure.equipment.voltage': 'el', 'measure.equipment.frequency': 'la',
  'measure.equipment.flow': 'el', 'measure.equipment.temperature': 'la',
  'measure.coverage.length': 'la', 'measure.coverage.area': 'el',
  'text.ingredients': 'los', 'text.protein_origin': 'el', 'text.composition': 'la',
  'text.manufacturer_care': 'los', 'text.instructions': 'las',
  'text.clinical_analysis': 'el', 'text.concentration': 'la',
  'text.regulatory_warnings': 'las',
});

function requiredMessage(code: string, label: string | undefined): string {
  const article = ARTICLES[code];
  const shipped = (DEFINITION_LABELS as Record<string, string>)[code];
  // Only the shipped label has a known gender; a customized one is quoted.
  if (article && label === shipped) {
    const verb = article === 'los' || article === 'las' ? 'Faltan' : 'Falta';
    return `${verb} ${article} ${label.charAt(0).toLowerCase()}${label.slice(1)}.`;
  }
  return `Completa «${label ?? code}».`;
}

function messageOf(
  item: PublicationProblemV2,
  labels: ReadonlyMap<string, string>,
): string {
  if (item.scope === 'definition' && item.definitionCode !== null) {
    if (item.problem === 'REQUIRED_MISSING')
      return requiredMessage(
        item.definitionCode,
        labels.get(item.definitionCode),
      );
    return READINESS_MESSAGES.definition[item.problem];
  }
  if (item.scope === 'care')
    return READINESS_MESSAGES.care[item.detail ?? 'REVIEW_MISSING'];
  if (item.scope === 'variant') return READINESS_MESSAGES.variant[item.problem];
  return READINESS_MESSAGES.product[
    item.problem === 'REQUIRED_MISSING' ? item.detail! : item.problem
  ];
}

/** Pure projection of evaluated problems to the agreed readiness response. */
export function presentPublicationReadinessV2(input: {
  problems: readonly PublicationProblemV2[];
  familyCode: string | null;
  definitions: readonly { code: string; label: string }[];
  cycle: number | null;
  draftRevision: number | null;
  vocabularyRevision: string;
}): ReadinessV2 {
  const labels = new Map(input.definitions.map((d) => [d.code, d.label]));
  const sections = new Map<string, SectionCode>();
  if (isProductionFamily(input.familyCode))
    for (const section of FAMILY_SECTIONS[input.familyCode])
      for (const code of section.definitionCodes)
        sections.set(code, section.code);
  const bySection: Partial<Record<SectionCode, number>> = {};
  const items = input.problems.map((item): ReadinessItemV2 => {
    const sectionCode =
      item.scope === 'definition' && item.definitionCode !== null
        ? (sections.get(item.definitionCode) ?? null)
        : null;
    if (sectionCode) bySection[sectionCode] = (bySection[sectionCode] ?? 0) + 1;
    return {
      scope: item.scope,
      definitionCode: item.scope === 'definition' ? item.definitionCode : null,
      variantId: item.variantId,
      sectionCode,
      problem: item.problem,
      message: messageOf(item, labels),
    };
  });
  return {
    ready: items.length === 0,
    cycle: input.cycle,
    draftRevision: input.draftRevision,
    vocabularyRevision: input.vocabularyRevision,
    items,
    bySection,
  };
}
