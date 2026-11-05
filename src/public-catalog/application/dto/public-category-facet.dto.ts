export interface PublicCatalogCategoryFacet {
  id: string;
  name: string;
  count: number;
}

/**
 * P4 S4 — one FACET choice attribute with per-option product counts that
 * apply every other selected facet but not its own. Switch on only.
 */
export interface PublicCatalogAttributeFacet {
  code: string;
  label: string;
  options: { code: string; label: string; count: number }[];
}

/** P4 S4 — selected options of one FACET definition (OR within it). */
export interface PublicAttributeFacetSelection {
  code: string;
  options: string[];
}
