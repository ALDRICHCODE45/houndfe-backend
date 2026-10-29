import { FAMILY_CODES } from './editorial-production-vocabulary-catalog';
import { validateVocabularyConsistencyV2 } from './editorial-vocabulary-consistency-v2';
import { assertProductionAliasCoverageV2 } from './editorial-vocabulary-production-alias-coverage-v2';
import { assertProductionNumericDefinitionsV2 } from './editorial-vocabulary-production-numeric-v2';
import type { VocabularyV2 } from './editorial-vocabulary-shape-v2';

/** Dormant full-production candidate validation; not adoption or activation authority. */
export function validateFullProductionVocabularyV2(
  input: unknown,
): VocabularyV2 {
  const parsed = validateVocabularyConsistencyV2(input);
  const definitionsById = new Map(parsed.definitions.map((d) => [d.id, d]));
  const familyCodes = new Set(parsed.families.map((family) => family.code));
  if (FAMILY_CODES.some((code) => !familyCodes.has(code))) {
    throw new TypeError('Expected a full production vocabulary V2');
  }
  for (const family of parsed.families) {
    // Include custom families: the inherited policy assertion rejects fact_rule borrowing.
    assertProductionNumericDefinitionsV2(family, definitionsById);
    assertProductionAliasCoverageV2(family, definitionsById);
  }
  return parsed;
}
