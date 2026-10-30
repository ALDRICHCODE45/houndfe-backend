import { buildEditorialEvaluationSetV2 } from './editorial-evaluation-set-v2';
import type { FactInputsV2 } from './editorial-fact-rule-evaluation-v2';
import { assertSelectedBindingReadinessV2 } from './editorial-selected-binding-readiness-v2';
import type { ValueV2 } from './editorial-value-shape-v2';
import type { FamilyV2 } from './editorial-vocabulary-family-shape-v2';

/** Scheduled binding readiness only; stable admitted inputs and caller-selected E. */
export function assertEditorialEvaluationReadinessV2(
  family: FamilyV2,
  values: readonly ValueV2[],
  eligibleSubjects: readonly (string | null)[],
  qualifiedFactsBySubject: ReadonlyMap<string | null, FactInputsV2>,
): void {
  const entries = buildEditorialEvaluationSetV2(
    family,
    values,
    eligibleSubjects,
    qualifiedFactsBySubject,
  );
  for (const entry of entries) {
    const value = values.find(
      (item) => item.code === entry.code && item.variantId === entry.variantId,
    );
    assertSelectedBindingReadinessV2(entry.result, value);
  }
}
