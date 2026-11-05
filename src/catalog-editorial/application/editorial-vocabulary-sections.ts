import { isProductionFamily } from '../domain/editorial-production-vocabulary-catalog';
import {
  FAMILY_SECTIONS,
  SECTION_LABELS,
  type SectionCode,
} from '../domain/editorial-production-vocabulary-sections';

type Family = { code: string; bindings: { definitionCode: string }[] };
type Body = { vocabulary: { families: Family[] } };
export type FamilySection = {
  code: SectionCode;
  label: string;
  sortOrder: number;
};
export type SectionedFamily<F extends Family> = F & {
  sections?: FamilySection[];
  bindings: (F['bindings'][number] & {
    sectionCode?: SectionCode;
    sectionSortOrder?: number;
  })[];
};
export type SectionedBody<B extends Body> = B & {
  vocabulary: {
    families: SectionedFamily<B['vocabulary']['families'][number]>[];
  };
};

/** Form grouping attached AFTER the revision is computed, like descriptions: it is
 * presentation, not vocabulary semantics. Pure; only production families get it.
 * `sortOrder` is the section's fixed position (gaps when a section has no bound
 * definition); keys are omitted (never null) for unsectioned families/bindings.
 */
export function withFamilySections<B extends Body>(body: B): SectionedBody<B> {
  let changed = false;
  const families = body.vocabulary.families.map((family) => {
    if (!isProductionFamily(family.code)) return family;
    const placed = new Map<string, [SectionCode, number, number]>();
    FAMILY_SECTIONS[family.code].forEach(({ code, definitionCodes }, s) =>
      definitionCodes.forEach((definitionCode, d) =>
        placed.set(definitionCode, [code, s, d]),
      ),
    );
    const present = new Set<number>();
    const bindings = family.bindings.map((binding) => {
      const place = placed.get(binding.definitionCode);
      if (!place) return binding;
      present.add(place[1]);
      return { ...binding, sectionCode: place[0], sectionSortOrder: place[2] };
    });
    if (present.size === 0) return family;
    changed = true;
    const sections = FAMILY_SECTIONS[family.code].flatMap(({ code }, s) =>
      present.has(s)
        ? [{ code, label: SECTION_LABELS[code], sortOrder: s }]
        : [],
    );
    return { ...family, sections, bindings };
  });
  if (!changed) return body as SectionedBody<B>;
  return {
    ...body,
    vocabulary: { ...body.vocabulary, families },
  } as SectionedBody<B>;
}
