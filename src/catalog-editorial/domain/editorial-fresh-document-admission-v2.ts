import { fail, type DocumentAuthority } from './document';
import { assertFreshCareCaptureV2 } from './editorial-care-capture-v2';
import {
  freshDocumentLimitProblemsV2,
  type DocumentLimitProblemV2,
} from './editorial-document-limits-v2';
import { assertFreshDocumentReferencesV2 } from './editorial-document-references-v2';
import type { DocumentShapeV2 } from './editorial-document-shape-v2';
import { isFreshEvidenceV2 } from './editorial-evidence-v2';
import type { FactInputsV2 } from './editorial-fact-rule-evaluation-v2';
import { qualifyFactsV2 } from './editorial-facts-qualification-v2';
import { collectFreshNAAdmissionProblemsV2 } from './editorial-na-admission-v2';
import { collectFreshNumericAdmissionProblemsV2 } from './editorial-numeric-admission-v2';
import type { NumericPayloadProblemV2 } from './editorial-numeric-payload-v2';
import type { VocabularyV2 } from './editorial-vocabulary-shape-v2';

export type AdmissionProblemV2 =
  | { kind: 'limits'; problem: DocumentLimitProblemV2 }
  | { kind: 'evidence'; code: string; variantId: string | null }
  | {
      kind: 'numeric';
      code: string;
      variantId: string | null;
      problem: NumericPayloadProblemV2;
    }
  | { kind: 'na'; code: string; variantId: string | null };

/**
 * Fresh admission that collects its value-level problems. Reference, facts and
 * care-capture violations are not collectable: they still throw MALFORMED.
 */
export function collectFreshDocumentAdmissionV2(
  candidate: DocumentShapeV2,
  references: Pick<DocumentAuthority, 'variantIds' | 'assetIds'>,
  vocabulary: Pick<VocabularyV2, 'families' | 'definitions'>,
  operation: 'save' | 'publish',
): {
  facts: ReadonlyMap<string | null, FactInputsV2>;
  problems: AdmissionProblemV2[];
} {
  assertFreshDocumentReferencesV2(candidate, references, vocabulary);
  const problems: AdmissionProblemV2[] = freshDocumentLimitProblemsV2(
    candidate,
    operation,
  ).map((problem) => ({ kind: 'limits', problem }));
  const facts = new Map<string | null, FactInputsV2>();
  if (candidate.familyCode === null) return { facts, problems };
  const family = vocabulary.families.find(
    (item) => item.code === candidate.familyCode,
  )!;
  const definitions = new Map(
    vocabulary.definitions.map((definition) => [definition.id, definition]),
  );
  for (const value of candidate.values) {
    if (value.evidence !== null && !isFreshEvidenceV2(value.evidence))
      problems.push({
        kind: 'evidence',
        code: value.code,
        variantId: value.variantId,
      });
  }
  for (const problem of collectFreshNumericAdmissionProblemsV2(
    candidate.values,
    family,
    definitions,
    operation,
  ))
    problems.push({ kind: 'numeric', ...problem });
  for (const row of candidate.facts) {
    const qualified = qualifyFactsV2(row, family, definitions);
    if (row.careReview !== null) assertFreshCareCaptureV2(row.careReview);
    facts.set(row.variantId, qualified);
  }
  for (const problem of collectFreshNAAdmissionProblemsV2(
    candidate.values,
    family,
    facts,
  ))
    problems.push({ kind: 'na', ...problem });
  return { facts, problems };
}

/** Parsed fresh candidate and coherent metadata only; not save/publication authorization. */
export function admitFreshDocumentV2(
  candidate: DocumentShapeV2,
  references: Pick<DocumentAuthority, 'variantIds' | 'assetIds'>,
  vocabulary: Pick<VocabularyV2, 'families' | 'definitions'>,
  operation: 'save' | 'publish',
): ReadonlyMap<string | null, FactInputsV2> {
  const { facts, problems } = collectFreshDocumentAdmissionV2(
    candidate,
    references,
    vocabulary,
    operation,
  );
  if (problems.length) fail('MALFORMED');
  return facts;
}
