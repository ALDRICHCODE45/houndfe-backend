import type { DocumentShapeV2 } from '../domain/editorial-document-shape-v2';
import { fail } from '../domain/document';
import { hashEditorialJson } from '../domain/editorial-canonical-json';
import { assertCarePublicationReadinessV2 } from '../domain/editorial-care-publication-readiness-v2';
import type { CareAttestation } from './editorial-recorded-receipt-result-v2';

export type FreshCareAttestationInputV2 = {
  scope: Pick<CareAttestation, 'actorId' | 'tenantId' | 'productId'>;
  attempt: Pick<
    CareAttestation,
    'cycle' | 'draftRevision' | 'publishedRevision' | 'vocabularyRevision'
  >;
  confirmedAt: string;
  document: DocumentShapeV2;
  evaluationSubjects: readonly (string | null)[];
  confirmation: 'review-v1' | null;
};

/** Pure fresh-attempt dependency; the caller owns authorization, E and transaction provenance. */
export function buildFreshCareAttestationV2(
  input: FreshCareAttestationInputV2,
): CareAttestation | null {
  const {
    document,
    confirmation,
    evaluationSubjects,
    scope,
    attempt,
    confirmedAt,
  } = input;
  if (document.familyCode !== 'care') {
    if (confirmation !== null) fail('MALFORMED');
    return null;
  }
  if (confirmation !== 'review-v1') fail('MALFORMED');
  // E and facts identities are already unique and reference-admitted by the caller.
  const remaining = new Set(evaluationSubjects);
  const subjects: CareAttestation['subjects'] = [];
  for (const row of document.facts) {
    if (!remaining.has(row.variantId)) continue;
    assertCarePublicationReadinessV2(row.careReview);
    subjects.push({ variantId: row.variantId, presentation: row.presentation });
    remaining.delete(row.variantId);
  }
  if (remaining.size !== 0) fail('MALFORMED');
  return {
    actorId: scope.actorId,
    tenantId: scope.tenantId,
    productId: scope.productId,
    confirmedAt,
    cycle: attempt.cycle,
    draftRevision: attempt.draftRevision,
    publishedRevision: attempt.publishedRevision,
    vocabularyRevision: attempt.vocabularyRevision,
    documentDigest:
      'ecd2-sha256-' +
      hashEditorialJson({
        cycle: attempt.cycle,
        draftRevision: attempt.draftRevision,
        document,
      }),
    subjects,
  };
}
