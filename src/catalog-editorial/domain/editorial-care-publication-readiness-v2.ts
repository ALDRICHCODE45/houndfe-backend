import { fail } from './document';
import type { CareReviewCaptureV2 } from './editorial-care-capture-shape-v2';
import { assertFreshCareCaptureV2 } from './editorial-care-capture-v2';

/** One parsed review's readiness, not legal approval or publisher confirmation. */
export function assertCarePublicationReadinessV2(
  review: CareReviewCaptureV2 | null | undefined,
): void {
  if (!review || review.state !== 'prepared') fail('MALFORMED');
  assertFreshCareCaptureV2(review);
  if (review.evidence.length === 0) fail('MALFORMED');
  if (review.determination === 'none_applicable') {
    if (review.requirements.length !== 0 || review.warnings.length !== 0)
      fail('MALFORMED');
    return;
  }
  if (review.requirements.length === 0) fail('MALFORMED');
  for (const requirement of review.requirements) {
    if (
      (requirement.disposition !== 'satisfied' &&
        requirement.disposition !== 'not_applicable') ||
      requirement.evidence.length === 0
    )
      fail('MALFORMED');
  }
  for (const warning of review.warnings) {
    if (warning.disclosure !== 'private_only' || warning.evidence.length === 0)
      fail('MALFORMED');
  }
}
