import {
  classifyEditorialDocumentMode,
  type EditorialDocumentJson,
} from '../domain/editorial-document-mode';

/** Compatibility only; authority, receipt miss and locked active-Draft CAS are outer preconditions. */
export function assertFreshPublishCompatibilityV2(
  sourceDraft: { document: EditorialDocumentJson },
  currentPublished: { document: EditorialDocumentJson } | null,
): void {
  const draftMode = classifyEditorialDocumentMode(sourceDraft.document);
  const publishedMode =
    currentPublished === null
      ? null
      : classifyEditorialDocumentMode(currentPublished.document);

  if (draftMode === 'unsupported' || publishedMode === 'unsupported')
    throw new Error('EDITORIAL_CLIENT_UPGRADE_REQUIRED');
  if (draftMode === 'legacy') throw new Error('EDITORIAL_ADOPTION_REQUIRED');
}
