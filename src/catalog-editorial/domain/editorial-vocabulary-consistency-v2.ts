import { assertFamilyPolicyConsistencyV2 } from './editorial-vocabulary-family-consistency-v2';
import { assertFamilyReferencesV2 } from './editorial-vocabulary-family-references-v2';
import { assertFamilyOptionCaseStaticV2 } from './editorial-vocabulary-option-case-static-v2';
import {
  parseVocabularyShapeV2,
  type VocabularyV2,
} from './editorial-vocabulary-shape-v2';

/** Dormant generic consistency only; NOT whole production vocabulary admission. */
export function validateVocabularyConsistencyV2(input: unknown): VocabularyV2 {
  const parsed = parseVocabularyShapeV2(input);
  const definitionsById = new Map(parsed.definitions.map((d) => [d.id, d]));
  for (const family of parsed.families) {
    assertFamilyReferencesV2(family, definitionsById);
    assertFamilyPolicyConsistencyV2(family);
    assertFamilyOptionCaseStaticV2(family, definitionsById);
  }
  return parsed;
}
