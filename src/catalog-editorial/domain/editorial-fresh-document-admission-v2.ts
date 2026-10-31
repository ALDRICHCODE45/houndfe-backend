import { fail, type DocumentAuthority } from './document';
import { assertFreshCareCaptureV2 } from './editorial-care-capture-v2';
import { assertFreshDocumentLimitsV2 } from './editorial-document-limits-v2';
import { assertFreshDocumentReferencesV2 } from './editorial-document-references-v2';
import type { DocumentShapeV2 } from './editorial-document-shape-v2';
import { isFreshEvidenceV2 } from './editorial-evidence-v2';
import type { FactInputsV2 } from './editorial-fact-rule-evaluation-v2';
import { qualifyFactsV2 } from './editorial-facts-qualification-v2';
import { assertFreshNAAdmissionV2 } from './editorial-na-admission-v2';
import { assertFreshNumericAdmissionV2 } from './editorial-numeric-admission-v2';
import type { VocabularyV2 } from './editorial-vocabulary-shape-v2';

/** Parsed fresh candidate and coherent metadata only; not save/publication authorization. */
export function admitFreshDocumentV2(
  candidate: DocumentShapeV2,
  references: Pick<DocumentAuthority, 'variantIds' | 'assetIds'>,
  vocabulary: Pick<VocabularyV2, 'families' | 'definitions'>,
  operation: 'save' | 'publish',
): ReadonlyMap<string | null, FactInputsV2> {
  assertFreshDocumentReferencesV2(candidate, references, vocabulary);
  assertFreshDocumentLimitsV2(candidate, operation);
  const facts = new Map<string | null, FactInputsV2>();
  if (candidate.familyCode === null) return facts;
  const family = vocabulary.families.find(
    (item) => item.code === candidate.familyCode,
  )!;
  const definitions = new Map(
    vocabulary.definitions.map((definition) => [definition.id, definition]),
  );
  for (const value of candidate.values) {
    if (value.evidence !== null && !isFreshEvidenceV2(value.evidence))
      fail('MALFORMED');
  }
  assertFreshNumericAdmissionV2(
    candidate.values,
    family,
    definitions,
    operation,
  );
  for (const row of candidate.facts) {
    const qualified = qualifyFactsV2(row, family, definitions);
    if (row.careReview !== null) assertFreshCareCaptureV2(row.careReview);
    facts.set(row.variantId, qualified);
  }
  assertFreshNAAdmissionV2(candidate.values, family, facts);
  return facts;
}
