import { parseDocumentShapeV2 } from './editorial-document-shape-v2';
import type { KnownPayloadV2 } from './editorial-known-payload-shape-v2';
import { isProductionFamily } from './editorial-production-vocabulary-catalog';
import {
  FAMILY_SECTIONS,
  SECTION_LABELS,
} from './editorial-production-vocabulary-sections';

/** One public (FACET or DETAIL) binding of a family, with its es-MX labels. */
export type PublicVocabularyBindingV2 = {
  readonly definitionCode: string;
  readonly label: string;
  readonly type: string;
  readonly exposure: 'FACET' | 'DETAIL';
  readonly sortOrder: number;
  /** option code → label */
  readonly options: ReadonlyMap<string, string>;
  /** unit code → label (null label: the code is its own label) */
  readonly units: ReadonlyMap<string, string | null>;
};

/** family code → definition code → public binding. INTERNAL is never present. */
export type PublicVocabularyV2 = ReadonlyMap<
  string,
  ReadonlyMap<string, PublicVocabularyBindingV2>
>;

type Option = { code: string; label: string };
type Unit = { code: string; label: string };

export type PublicEditorialAttributeV2 = {
  code: string;
  label: string;
  facet: boolean;
  section: { code: string; label: string } | null;
  value:
    | { type: 'text'; text: string }
    | { type: 'boolean'; value: boolean }
    | { type: 'single'; option: Option }
    | { type: 'multi'; options: Option[] }
    | { type: 'number'; value: number; unit: Unit | null }
    | { type: 'range'; min: number; max: number; unit: Unit };
  display: string;
};

export type PublicEditorialProjectionV2 = {
  commercialTitle: string | null;
  description: string | null;
  /** Values with no variant: product-owned and the simple presentation. */
  attributes: PublicEditorialAttributeV2[];
  /** Sellable values per variant id. */
  variantAttributes: ReadonlyMap<string, PublicEditorialAttributeV2[]>;
};

function unitOf(
  binding: PublicVocabularyBindingV2,
  code: string,
): Unit | undefined {
  if (!binding.units.has(code)) return undefined;
  return { code, label: binding.units.get(code) ?? code };
}

function valueOf(
  binding: PublicVocabularyBindingV2,
  payload: KnownPayloadV2,
): Pick<PublicEditorialAttributeV2, 'value' | 'display'> | undefined {
  if (payload.type !== binding.type) return undefined;
  switch (payload.type) {
    case 'text':
      return {
        value: { type: 'text', text: payload.value },
        display: payload.value,
      };
    case 'boolean':
      return {
        value: { type: 'boolean', value: payload.value },
        display: payload.value ? 'Sí' : 'No',
      };
    case 'single': {
      const label = binding.options.get(payload.value);
      if (label === undefined) return undefined;
      return {
        value: { type: 'single', option: { code: payload.value, label } },
        display: label,
      };
    }
    case 'multi': {
      const options = payload.value.flatMap((code) => {
        const label = binding.options.get(code);
        return label === undefined ? [] : [{ code, label }];
      });
      if (options.length === 0) return undefined;
      return {
        value: { type: 'multi', options },
        display: options.map((option) => option.label).join(', '),
      };
    }
    case 'number': {
      if (payload.unit === null)
        return {
          value: { type: 'number', value: payload.value, unit: null },
          display: String(payload.value),
        };
      const unit = unitOf(binding, payload.unit);
      if (!unit) return undefined;
      return {
        value: { type: 'number', value: payload.value, unit },
        display: `${payload.value} ${unit.label}`,
      };
    }
    case 'range': {
      const unit = unitOf(binding, payload.unit);
      if (!unit) return undefined;
      return {
        value: { type: 'range', min: payload.min, max: payload.max, unit },
        display: `${payload.min}–${payload.max} ${unit.label}`,
      };
    }
  }
}

/**
 * Public projection of a Published document (P4 S3): commercial title,
 * description and the `known` values whose binding is FACET or DETAIL in the
 * document's family, with vocabulary labels. Evidence, facts/declarations,
 * care review and every other document field are never read into the result.
 * Values whose definition, option or unit is not in the public vocabulary are
 * left out. Ordered by the family's form sections, then binding order.
 * Throws when the stored document is not a document shape V2.
 */
export function projectPublishedEditorialV2(
  document: unknown,
  vocabulary: PublicVocabularyV2,
): PublicEditorialProjectionV2 {
  const parsed = parseDocumentShapeV2(document);
  const family =
    parsed.familyCode === null ? undefined : vocabulary.get(parsed.familyCode);
  const placed = new Map<string, [number, number, string]>();
  if (parsed.familyCode !== null && isProductionFamily(parsed.familyCode))
    FAMILY_SECTIONS[parsed.familyCode].forEach(({ code, definitionCodes }, s) =>
      definitionCodes.forEach((definitionCode, d) =>
        placed.set(definitionCode, [s, d, code]),
      ),
    );

  const ranked: {
    variantId: string | null;
    rank: [number, number, number];
    attribute: PublicEditorialAttributeV2;
  }[] = [];
  for (const value of parsed.values) {
    if (value.state !== 'known' || !family) continue;
    const binding = family.get(value.code);
    if (!binding) continue;
    const projected = valueOf(binding, value.payload);
    if (!projected) continue;
    const place = placed.get(value.code);
    ranked.push({
      variantId: value.variantId,
      rank: place
        ? [place[0], place[1], binding.sortOrder]
        : [Number.MAX_SAFE_INTEGER, binding.sortOrder, binding.sortOrder],
      attribute: {
        code: binding.definitionCode,
        label: binding.label,
        facet: binding.exposure === 'FACET',
        section: place
          ? {
              code: place[2],
              label: SECTION_LABELS[place[2] as keyof typeof SECTION_LABELS],
            }
          : null,
        ...projected,
      },
    });
  }
  ranked.sort(
    (a, b) =>
      a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2],
  );

  const attributes: PublicEditorialAttributeV2[] = [];
  const variantAttributes = new Map<string, PublicEditorialAttributeV2[]>();
  for (const { variantId, attribute } of ranked) {
    if (variantId === null) {
      attributes.push(attribute);
      continue;
    }
    const list = variantAttributes.get(variantId) ?? [];
    list.push(attribute);
    variantAttributes.set(variantId, list);
  }
  return {
    commercialTitle: parsed.commercialTitle,
    description: parsed.description,
    attributes,
    variantAttributes,
  };
}
