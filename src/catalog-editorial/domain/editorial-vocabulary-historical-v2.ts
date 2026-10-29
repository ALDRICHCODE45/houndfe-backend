import { createVocabularyResponseV2 } from './editorial-vocabulary-canonical-v2';
import { materializeStoredVocabularyV2 } from './editorial-vocabulary-stored-root-v2';

/** Dormant whole-response boundary; raw validity does not certify SQL provenance. */
export function materializeHistoricalVocabularyResponseV2(
  input: unknown,
): ReturnType<typeof createVocabularyResponseV2> {
  const vocabulary = materializeStoredVocabularyV2(input);
  return createVocabularyResponseV2(vocabulary);
}
