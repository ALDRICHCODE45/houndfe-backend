import {
  classifyEditorialDocumentMode,
  type EditorialDocumentJson,
} from '../domain/editorial-document-mode';
import type { VocabularyReadSnapshot } from '../domain/editorial-vocabulary-projection-v1';

/** Complete coherent family metadata; fresh reads/writes only, never matching receipt replay. */
export function assertEditorialCompatibilityV1(
  state: {
    draft: { document: EditorialDocumentJson } | null;
    published: { document: EditorialDocumentJson } | null;
  },
  candidateFamilyCode: string | null,
  vocabulary: Pick<VocabularyReadSnapshot, 'families'>,
): void {
  const advancedState = [state.draft, state.published].some(
    (slot) =>
      slot !== null &&
      classifyEditorialDocumentMode(slot.document) !== 'legacy',
  );
  const advancedFamily =
    candidateFamilyCode !== null &&
    vocabulary.families.some(
      (family) =>
        family.code === candidateFamilyCode &&
        family.minimumContractVersion === 2,
    );
  if (advancedState || advancedFamily)
    throw new Error('EDITORIAL_CLIENT_UPGRADE_REQUIRED');
}
