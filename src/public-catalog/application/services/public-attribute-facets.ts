import type { FacetValuesV2 } from '../../../catalog-editorial/domain/editorial-public-facets-v2';
import type {
  PublicAttributeFacetSelection,
  PublicCatalogAttributeFacet,
} from '../dto/public-category-facet.dto';

/** A product and the FACET values of each of its covered sellable subjects. */
export type FacetCandidate = {
  id: string;
  subjects: readonly FacetValuesV2[];
};

/** definition code → selected option codes (OR within, AND between). */
export type FacetSelection = ReadonlyMap<string, ReadonlySet<string>>;

export type FacetDefinitions = ReadonlyMap<
  string,
  { readonly label: string; readonly options: ReadonlyMap<string, string> }
>;

export function toFacetSelection(
  input: readonly PublicAttributeFacetSelection[] | undefined,
): FacetSelection {
  const selection = new Map<string, Set<string>>();
  for (const { code, options } of input ?? []) {
    const chosen = selection.get(code) ?? new Set<string>();
    for (const option of options) chosen.add(option);
    selection.set(code, chosen);
  }
  return selection;
}

/** The first selected definition/option the definitions do not know, if any. */
export function unknownFacetSelection(
  selection: FacetSelection,
  definitions: FacetDefinitions,
): string | null {
  for (const [code, options] of selection) {
    const definition = definitions.get(code);
    if (!definition) return code;
    for (const option of options)
      if (!definition.options.has(option)) return `${code}:${option}`;
  }
  return null;
}

/** One subject satisfies every selected definition (skipping `except`). */
function subjectMatches(
  subject: FacetValuesV2,
  selection: FacetSelection,
  except?: string,
): boolean {
  for (const [code, chosen] of selection) {
    if (code === except) continue;
    const held = subject.get(code);
    if (!held || ![...chosen].some((option) => held.has(option))) return false;
  }
  return true;
}

/**
 * Correlated matching (P4 S4): a product matches when ONE covered sellable
 * subject satisfies every selected definition; values spread over different
 * variants do not combine.
 */
export function matchFacetSelection(
  candidates: readonly FacetCandidate[],
  selection: FacetSelection,
): string[] {
  return candidates
    .filter((c) => c.subjects.some((s) => subjectMatches(s, selection)))
    .map((c) => c.id);
}

/**
 * Per definition and option, the number of unique products with a subject
 * that holds the option and satisfies every OTHER selected definition (the
 * facet's own selection is excluded). Options with no product are omitted
 * unless selected (count 0); definitions without options are omitted.
 * Definitions and options ordered by es-MX label.
 */
export function countFacets(
  candidates: readonly FacetCandidate[],
  selection: FacetSelection,
  definitions: FacetDefinitions,
): PublicCatalogAttributeFacet[] {
  const counts = new Map<string, Map<string, number>>();
  for (const [code] of selection) counts.set(code, new Map());
  for (const { subjects } of candidates) {
    const held = new Map<string, Set<string>>();
    for (const subject of subjects)
      for (const [code, options] of subject) {
        if (!subjectMatches(subject, selection, code)) continue;
        const set = held.get(code) ?? new Set<string>();
        for (const option of options) set.add(option);
        held.set(code, set);
      }
    for (const [code, options] of held) {
      const byOption = counts.get(code) ?? new Map<string, number>();
      counts.set(code, byOption);
      for (const option of options)
        byOption.set(option, (byOption.get(option) ?? 0) + 1);
    }
  }
  const byLabel = (a: { label: string }, b: { label: string }) =>
    a.label.localeCompare(b.label, 'es-MX');
  const facets: PublicCatalogAttributeFacet[] = [];
  for (const [code, byOption] of counts) {
    const definition = definitions.get(code);
    if (!definition) continue;
    for (const option of selection.get(code) ?? [])
      if (!byOption.has(option)) byOption.set(option, 0);
    const options = [...byOption].flatMap(([option, count]) => {
      const label = definition.options.get(option);
      return label === undefined ? [] : [{ code: option, label, count }];
    });
    if (options.length === 0) continue;
    facets.push({
      code,
      label: definition.label,
      options: options.sort(byLabel),
    });
  }
  return facets.sort(byLabel);
}
