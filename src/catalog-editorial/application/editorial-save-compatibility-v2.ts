import {
  classifyEditorialDocumentMode,
  type EditorialDocumentJson,
} from '../domain/editorial-document-mode';
import { isRecognizableLegacyDocument } from '../domain/editorial-legacy-document-recognition';

/** Fresh save only: caller establishes authority, receipt miss and locked Draft CAS. */
export function assertFreshSaveCompatibilityV2(
  sourceDraft: { document: EditorialDocumentJson },
  adoption: 'legacy-to-v2' | null,
): void {
  const mode = classifyEditorialDocumentMode(sourceDraft.document);
  if (
    mode === 'unsupported' ||
    (mode === 'legacy' && !isRecognizableLegacyDocument(sourceDraft.document))
  ) {
    throw new Error('EDITORIAL_CLIENT_UPGRADE_REQUIRED');
  }

  // Representability must win over a missing/forbidden conditional header.
  if (
    (mode === 'legacy' && adoption !== 'legacy-to-v2') ||
    (mode === 'production-v2' && adoption !== null)
  ) {
    throw new Error('MALFORMED');
  }
}
