import { fail } from './document';
import type { CareReviewCaptureV2 } from './editorial-care-capture-shape-v2';
import { assertFreshCareCaptureV2 } from './editorial-care-capture-v2';

export type CareReviewGapV2 =
  | 'REVIEW_MISSING'
  | 'REVIEW_EVIDENCE_MISSING'
  | 'NONE_APPLICABLE_HAS_ENTRIES'
  | 'REQUIREMENTS_MISSING'
  | 'REQUIREMENT_OPEN'
  | 'WARNING_PUBLIC'
  | 'WARNING_OPEN';

/**
 * Every distinct readiness gap of one parsed review (empty when ready). An invalid
 * prepared capture is not a gap: it still throws through the capture validator.
 */
export function carePublicationReadinessGapsV2(
  review: CareReviewCaptureV2 | null | undefined,
): CareReviewGapV2[] {
  if (!review || review.state !== 'prepared') return ['REVIEW_MISSING'];
  assertFreshCareCaptureV2(review);
  const gaps = new Set<CareReviewGapV2>();
  if (review.evidence.length === 0) gaps.add('REVIEW_EVIDENCE_MISSING');
  if (review.determination === 'none_applicable') {
    if (review.requirements.length !== 0 || review.warnings.length !== 0)
      gaps.add('NONE_APPLICABLE_HAS_ENTRIES');
    return [...gaps];
  }
  if (review.requirements.length === 0) gaps.add('REQUIREMENTS_MISSING');
  for (const requirement of review.requirements) {
    if (
      (requirement.disposition !== 'satisfied' &&
        requirement.disposition !== 'not_applicable') ||
      requirement.evidence.length === 0
    )
      gaps.add('REQUIREMENT_OPEN');
  }
  for (const warning of review.warnings) {
    // D11: a warning that must be shown publicly blocks; no public channel exists yet.
    if (warning.disclosure === 'public_required') gaps.add('WARNING_PUBLIC');
    else if (warning.disclosure !== 'private_only') gaps.add('WARNING_OPEN');
    if (warning.evidence.length === 0) gaps.add('WARNING_OPEN');
  }
  return [...gaps];
}

/** One parsed review's readiness, not legal approval or publisher confirmation. */
export function assertCarePublicationReadinessV2(
  review: CareReviewCaptureV2 | null | undefined,
): void {
  if (carePublicationReadinessGapsV2(review).length) fail('MALFORMED');
}
