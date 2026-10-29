import type { DocumentShapeV2 } from './editorial-document-shape-v2';

/** Parsed fresh candidates only; never historical reads, initialization copies or replay. */
export function assertFreshDocumentLimitsV2(
  candidate: DocumentShapeV2,
  operation: 'save' | 'publish',
): void {
  if (
    (candidate.commercialTitle !== null &&
      [...candidate.commercialTitle].length > 200) ||
    (candidate.description !== null &&
      [...candidate.description].length > 20000) ||
    candidate.mediaRefs.length > 20 ||
    candidate.values.length > 200 ||
    candidate.facts.length > 200 ||
    (operation === 'publish' &&
      (candidate.commercialTitle === null ||
        candidate.commercialTitle.trim() === '' ||
        candidate.mediaRefs.length !== 0))
  )
    throw new Error('MALFORMED');
}
