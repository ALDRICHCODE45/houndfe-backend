/** Known single/multi values of one Published document (P4 S4). */
export type PublicFacetSourceV2 = {
  readonly familyCode: string | null;
  readonly choices: readonly {
    readonly code: string;
    readonly variantId: string | null;
    readonly options: readonly string[];
  }[];
};

/** FACET single/multi definitions and, per family, which ones are FACET. */
export type PublicFacetVocabularyV2 = {
  readonly definitions: ReadonlyMap<
    string,
    { readonly label: string; readonly options: ReadonlyMap<string, string> }
  >;
  readonly byFamily: ReadonlyMap<string, ReadonlySet<string>>;
};

/** definition code → selected/held option codes */
export type FacetValuesV2 = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * FACET values of each subject of a Published document: key `null` holds the
 * values with no variant (product-owned and the simple presentation); a
 * variant key holds that variant's values merged with the `null` ones, since
 * product values apply to every sellable. Only definitions that are FACET in
 * the document's family and options of the public vocabulary count — the same
 * rule as the detail `attributes` with `facet: true`.
 */
export function facetValuesBySubjectV2(
  source: PublicFacetSourceV2,
  vocabulary: PublicFacetVocabularyV2,
): (variantId: string | null) => FacetValuesV2 {
  const facets =
    source.familyCode === null
      ? undefined
      : vocabulary.byFamily.get(source.familyCode);
  const bySubject = new Map<string | null, Map<string, Set<string>>>();
  for (const { code, variantId, options } of source.choices) {
    const definition = vocabulary.definitions.get(code);
    if (!facets?.has(code) || !definition) continue;
    const known = options.filter((option) => definition.options.has(option));
    if (known.length === 0) continue;
    const values = bySubject.get(variantId) ?? new Map<string, Set<string>>();
    bySubject.set(variantId, values);
    const held = values.get(code) ?? new Set<string>();
    values.set(code, held);
    for (const option of known) held.add(option);
  }
  const shared = bySubject.get(null) ?? new Map<string, Set<string>>();
  return (variantId) => {
    if (variantId === null) return shared;
    const own = bySubject.get(variantId);
    if (!own) return shared;
    const merged = new Map<string, Set<string>>(shared);
    for (const [code, options] of own)
      merged.set(code, new Set([...(shared.get(code) ?? []), ...options]));
    return merged;
  };
}
