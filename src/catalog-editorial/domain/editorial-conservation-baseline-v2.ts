import type { DocumentAuthority } from './document';
import { isRecognizableDocumentV2 } from './editorial-document-recognition-v2';
import { assertFreshDocumentReferencesV2 } from './editorial-document-references-v2';
import { EditorialDocumentShapeError } from './editorial-document-shape-error';
import {
  parseDocumentShapeV2,
  type DocumentShapeV2,
} from './editorial-document-shape-v2';
import type { VocabularyV2 } from './editorial-vocabulary-shape-v2';

/** Whole S42 baseline eligibility, not fresh admission or archive permission. */
export function eligibleConservationBaselineV2(
  input: unknown,
  references: Pick<DocumentAuthority, 'variantIds' | 'assetIds'>,
  vocabulary: Pick<VocabularyV2, 'families' | 'definitions'>,
): DocumentShapeV2 | null {
  let document: DocumentShapeV2;
  try {
    document = parseDocumentShapeV2(input);
  } catch (error) {
    if (error instanceof EditorialDocumentShapeError) return null;
    throw error;
  }
  // Recognize the detached snapshot rather than observing submitted input twice.
  if (!isRecognizableDocumentV2(document)) return null;
  try {
    assertFreshDocumentReferencesV2(document, references, vocabulary);
  } catch (error) {
    if (
      error instanceof Error &&
      Object.getPrototypeOf(error) === Error.prototype &&
      error.message === 'MALFORMED'
    )
      return null;
    throw error;
  }
  return document;
}
