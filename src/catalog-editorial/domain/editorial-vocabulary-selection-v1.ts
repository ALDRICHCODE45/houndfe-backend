/** Membership only: callers supply the complete, stable original binding graph. */
export function indexVocabularyV1Bindings(
  families: readonly {
    minimumContractVersion: 1 | 2;
    bindings: readonly { definitionId: string }[];
  }[],
): {
  originallyBound: ReadonlySet<string>;
  retained: ReadonlySet<string>;
} {
  const originallyBound = new Set<string>();
  const retained = new Set<string>();
  for (const family of families) {
    for (const binding of family.bindings) {
      originallyBound.add(binding.definitionId);
      if (family.minimumContractVersion === 1)
        retained.add(binding.definitionId);
    }
  }
  return { originallyBound, retained };
}
