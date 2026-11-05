import type { DocumentShapeV2 } from './editorial-document-shape-v2';

export type DocumentLimitProblemV2 =
  | 'BOUNDS'
  | 'TITLE_REQUIRED'
  | 'MEDIA_NOT_ALLOWED';

/** Every fresh-limit problem of a parsed candidate, in a fixed order. */
export function freshDocumentLimitProblemsV2(
  candidate: DocumentShapeV2,
  operation: 'save' | 'publish',
): DocumentLimitProblemV2[] {
  const problems: DocumentLimitProblemV2[] = [];
  if (
    (candidate.commercialTitle !== null &&
      [...candidate.commercialTitle].length > 200) ||
    (candidate.description !== null &&
      [...candidate.description].length > 20000) ||
    candidate.mediaRefs.length > 20 ||
    candidate.values.length > 200 ||
    candidate.facts.length > 200
  )
    problems.push('BOUNDS');
  if (operation === 'publish') {
    if (
      candidate.commercialTitle === null ||
      candidate.commercialTitle.trim() === ''
    )
      problems.push('TITLE_REQUIRED');
    if (candidate.mediaRefs.length !== 0) problems.push('MEDIA_NOT_ALLOWED');
  }
  return problems;
}

/** Parsed fresh candidates only; never historical reads, initialization copies or replay. */
export function assertFreshDocumentLimitsV2(
  candidate: DocumentShapeV2,
  operation: 'save' | 'publish',
): void {
  if (freshDocumentLimitProblemsV2(candidate, operation).length)
    throw new Error('MALFORMED');
}
