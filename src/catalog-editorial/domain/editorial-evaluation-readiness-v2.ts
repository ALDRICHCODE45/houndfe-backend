import { fail } from './document';
import { buildEditorialEvaluationSetV2 } from './editorial-evaluation-set-v2';
import type { FactInputsV2 } from './editorial-fact-rule-evaluation-v2';
import {
  selectedBindingProblemV2,
  type SelectedBindingProblemV2,
} from './editorial-selected-binding-readiness-v2';
import type { ValueV2 } from './editorial-value-shape-v2';
import type { FamilyV2 } from './editorial-vocabulary-family-shape-v2';

export type EvaluationProblemV2 = {
  code: string;
  variantId: string | null;
  problem: SelectedBindingProblemV2;
};

/** Every scheduled binding that is not ready, in evaluation-set order. */
export function collectEditorialEvaluationProblemsV2(
  family: FamilyV2,
  values: readonly ValueV2[],
  eligibleSubjects: readonly (string | null)[],
  qualifiedFactsBySubject: ReadonlyMap<string | null, FactInputsV2>,
): EvaluationProblemV2[] {
  const entries = buildEditorialEvaluationSetV2(
    family,
    values,
    eligibleSubjects,
    qualifiedFactsBySubject,
  );
  const problems: EvaluationProblemV2[] = [];
  for (const entry of entries) {
    const value = values.find(
      (item) => item.code === entry.code && item.variantId === entry.variantId,
    );
    const problem = selectedBindingProblemV2(entry.result, value);
    if (problem !== null)
      problems.push({ code: entry.code, variantId: entry.variantId, problem });
  }
  return problems;
}

/** Scheduled binding readiness only; stable admitted inputs and caller-selected E. */
export function assertEditorialEvaluationReadinessV2(
  family: FamilyV2,
  values: readonly ValueV2[],
  eligibleSubjects: readonly (string | null)[],
  qualifiedFactsBySubject: ReadonlyMap<string | null, FactInputsV2>,
): void {
  if (
    collectEditorialEvaluationProblemsV2(
      family,
      values,
      eligibleSubjects,
      qualifiedFactsBySubject,
    ).length
  )
    fail('MALFORMED');
}
