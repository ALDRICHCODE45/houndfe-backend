import type { DocumentAuthority } from './document';
import { collectArchivedOptionConservationV2 } from './editorial-archived-option-conservation-v2';
import { carePublicationReadinessGapsV2 } from './editorial-care-publication-readiness-v2';
import { contentKindAgreementProblemV2 } from './editorial-content-kind-agreement-v2';
import type { DocumentShapeV2 } from './editorial-document-shape-v2';
import { collectEditorialEvaluationProblemsV2 } from './editorial-evaluation-readiness-v2';
import { hasFactConflictV2 } from './editorial-fact-consistency-v2';
import type { FactInputsV2 } from './editorial-fact-rule-evaluation-v2';
import { collectFreshDocumentAdmissionV2 } from './editorial-fresh-document-admission-v2';
import { toyDeterminationProblemV2 } from './editorial-toy-determination-agreement-v2';
import type { VocabularyV2 } from './editorial-vocabulary-shape-v2';

export type PublicationProblemCodeV2 =
  | 'REQUIRED_MISSING'
  | 'UNRESOLVED'
  | 'EVIDENCE_REQUIRED'
  | 'NA_NOT_ALLOWED'
  | 'NOT_APPLICABLE_VALUE'
  | 'MAGNITUDE_MISMATCH'
  | 'TOY_TYPES_MISMATCH'
  | 'FACTS_CONFLICT'
  | 'CARE_REVIEW_INCOMPLETE'
  | 'NUMERIC_POLICY_PENDING'
  | 'INVALID_VALUE'
  | 'ARCHIVED_OPTION'
  | 'MEDIA_NOT_ALLOWED'
  | 'NO_OFFERED_PRESENTATION'
  | 'DRAFT_INVALID'
  | 'NO_DRAFT';

/**
 * One publication blocker. `detail` is an internal discriminator for copy only
 * (the product field or the care gap); it is never part of the HTTP contract.
 */
export type PublicationProblemV2 = {
  scope: 'definition' | 'variant' | 'product' | 'care';
  definitionCode: string | null;
  variantId: string | null;
  problem: PublicationProblemCodeV2;
  detail: string | null;
};

export type PublicationReadinessInputV2 = {
  /** Parsed saved Draft. */
  document: DocumentShapeV2;
  references: Pick<DocumentAuthority, 'variantIds' | 'assetIds'>;
  vocabulary: Pick<VocabularyV2, 'families' | 'definitions'>;
  /** E: the offered subjects observed with the same state as the document. */
  offeredSubjects: readonly (string | null)[];
  /** Current Published document (raw), the publish conservation baseline. */
  publishedDocument: unknown;
};

function isMalformed(error: unknown): boolean {
  return (
    error instanceof Error &&
    Object.getPrototypeOf(error) === Error.prototype &&
    error.message === 'MALFORMED'
  );
}

const product = (
  problem: PublicationProblemCodeV2,
  detail: string | null = null,
): PublicationProblemV2 => ({
  scope: 'product',
  definitionCode: null,
  variantId: null,
  problem,
  detail,
});
const definition = (
  definitionCode: string,
  variantId: string | null,
  problem: PublicationProblemCodeV2,
): PublicationProblemV2 => ({
  scope: 'definition',
  definitionCode,
  variantId,
  problem,
  detail: null,
});

/**
 * The full V2 publication chain in collecting mode: empty means publish passes
 * validation. Each rule is the same function the throwing publish gates call.
 * Unexpected (non-MALFORMED) errors propagate unchanged.
 */
export function evaluatePublicationReadinessV2(
  input: PublicationReadinessInputV2,
): PublicationProblemV2[] {
  const { document, references, vocabulary, offeredSubjects } = input;
  const problems: PublicationProblemV2[] = [];
  const noOffer = offeredSubjects.length === 0;

  let facts: ReadonlyMap<string | null, FactInputsV2>;
  try {
    const admitted = collectFreshDocumentAdmissionV2(
      document,
      references,
      vocabulary,
      'publish',
    );
    facts = admitted.facts;
    for (const item of admitted.problems) {
      if (item.kind === 'limits')
        problems.push(
          item.problem === 'TITLE_REQUIRED'
            ? product('REQUIRED_MISSING', 'commercialTitle')
            : item.problem === 'MEDIA_NOT_ALLOWED'
              ? product('MEDIA_NOT_ALLOWED')
              : product('DRAFT_INVALID'),
        );
      else if (item.kind === 'evidence')
        problems.push(
          definition(item.code, item.variantId, 'EVIDENCE_REQUIRED'),
        );
      else if (item.kind === 'numeric')
        problems.push(definition(item.code, item.variantId, item.problem));
      else
        problems.push(definition(item.code, item.variantId, 'NA_NOT_ALLOWED'));
    }
  } catch (error) {
    if (!isMalformed(error)) throw error;
    return finish([product('DRAFT_INVALID')], noOffer, input);
  }
  if (document.familyCode === null)
    return finish(
      [...problems, product('REQUIRED_MISSING', 'familyCode')],
      noOffer,
      input,
    );
  const family = vocabulary.families.find(
    (item) => item.code === document.familyCode,
  )!;

  try {
    for (const item of collectArchivedOptionConservationV2(
      document,
      input.publishedDocument,
      references,
      vocabulary,
    ).problems)
      problems.push(definition(item.code, item.variantId, 'ARCHIVED_OPTION'));
  } catch (error) {
    if (!isMalformed(error)) throw error;
    return finish([product('DRAFT_INVALID')], noOffer, input);
  }

  for (const item of collectEditorialEvaluationProblemsV2(
    family,
    document.values,
    offeredSubjects,
    facts,
  ))
    problems.push(definition(item.code, item.variantId, item.problem));

  const subjectOf = (code: string, subject: string | null) =>
    family.bindings.find((b) => b.definitionCode === code)?.owner === 'product'
      ? null
      : subject;
  for (const subject of offeredSubjects) {
    const subjectFacts = facts.get(subject) ?? {};
    if (hasFactConflictV2(subjectFacts))
      problems.push({
        scope: 'variant',
        definitionCode: null,
        variantId: subject,
        problem: 'FACTS_CONFLICT',
        detail: null,
      });
    if (family.bindings.some((b) => b.definitionCode === 'content.kind')) {
      const variantId = subjectOf('content.kind', subject);
      const kind = document.values.find(
        (v) => v.code === 'content.kind' && v.variantId === variantId,
      );
      const problem = contentKindAgreementProblemV2(
        kind,
        subjectFacts.contentMagnitude,
      );
      if (problem)
        problems.push(definition('content.kind', variantId, problem));
    }
    if (family.code === 'toy') {
      const variantId = subjectOf('toy.type', subject);
      const toy = document.values.find(
        (v) => v.code === 'toy.type' && v.variantId === variantId,
      );
      // An unknown toy.type is reported by its own required binding.
      if (
        toy?.state === 'known' &&
        (toy.payload.type === 'multi' || toy.payload.type === 'single')
      ) {
        const selected =
          toy.payload.type === 'multi'
            ? toy.payload.value
            : [toy.payload.value];
        const problem = toyDeterminationProblemV2(
          selected,
          subjectFacts.relevantDimensionCodes,
        );
        if (problem) problems.push(definition('toy.type', variantId, problem));
      }
    }
    if (family.code === 'care') {
      const row = document.facts.find((item) => item.variantId === subject);
      for (const gap of carePublicationReadinessGapsV2(row?.careReview))
        problems.push({
          scope: 'care',
          definitionCode: null,
          variantId: subject,
          problem: 'CARE_REVIEW_INCOMPLETE',
          detail: gap,
        });
    }
  }
  return finish(problems, noOffer, input);
}

const scopeRank = { product: 0, care: 1, variant: 2, definition: 3 };

/** Adds the empty-E blocker, removes duplicates and orders deterministically. */
function finish(
  problems: PublicationProblemV2[],
  noOffer: boolean,
  input: PublicationReadinessInputV2,
): PublicationProblemV2[] {
  if (noOffer) problems.push(product('NO_OFFERED_PRESENTATION'));
  const family = input.vocabulary.families.find(
    (item) => item.code === input.document.familyCode,
  );
  const bindingRank = (code: string | null) => {
    const index =
      family?.bindings.findIndex((b) => b.definitionCode === code) ?? -1;
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  const subjectRank = (variantId: string | null) => {
    const index = input.offeredSubjects.indexOf(variantId);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  const seen = new Set<string>();
  const unique = problems.filter((item) => {
    const key = JSON.stringify([
      item.scope,
      item.definitionCode,
      item.variantId,
      item.problem,
      item.detail,
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Stable sort: equal keys keep the chain's own order.
  return unique
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        scopeRank[a.item.scope] - scopeRank[b.item.scope] ||
        subjectRank(a.item.variantId) - subjectRank(b.item.variantId) ||
        bindingRank(a.item.definitionCode) -
          bindingRank(b.item.definitionCode) ||
        a.index - b.index,
    )
    .map(({ item }) => item);
}
