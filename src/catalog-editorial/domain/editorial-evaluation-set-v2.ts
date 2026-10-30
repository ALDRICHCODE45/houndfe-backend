import { evaluateBindingPolicyV2 } from './editorial-binding-policy-evaluation-v2';
import type { FactInputsV2 } from './editorial-fact-rule-evaluation-v2';
import {
  selectOptionCaseV2,
  type RuleResultV2,
} from './editorial-option-case-evaluation-v2';
import type { ValueV2 } from './editorial-value-shape-v2';
import type {
  BindingV2,
  FamilyV2,
} from './editorial-vocabulary-family-shape-v2';

export type EvaluationEntryV2 = {
  code: string;
  variantId: string | null;
  result: RuleResultV2 | null;
};

/** Stable admitted metadata/values and qualified facts; not publication admission. */
export function buildEditorialEvaluationSetV2(
  family: FamilyV2,
  values: readonly ValueV2[],
  eligibleSubjects: readonly (string | null)[],
  qualifiedFactsBySubject: ReadonlyMap<string | null, FactInputsV2>,
): EvaluationEntryV2[] {
  const bindings = new Map(family.bindings.map((b) => [b.definitionCode, b]));
  const seen = new Map<string, Set<string | null>>();
  const queue: { binding: BindingV2; variantId: string | null }[] = [];
  const entries: EvaluationEntryV2[] = [];

  function enqueue(binding: BindingV2, subject: string | null): void {
    const variantId = binding.owner === 'product' ? null : subject;
    const subjects =
      seen.get(binding.definitionCode) ?? new Set<string | null>();
    if (subjects.has(variantId)) return;
    subjects.add(variantId);
    seen.set(binding.definitionCode, subjects);
    queue.push({ binding, variantId });
  }

  for (const binding of family.bindings) {
    const subjects = binding.owner === 'product' ? [null] : eligibleSubjects;
    for (const subject of subjects) {
      const value = values.find(
        (item) =>
          item.code === binding.definitionCode && item.variantId === subject,
      );
      if (
        binding.publicationCheck === 'always' ||
        value?.state === 'known' ||
        value?.state === 'not_applicable'
      )
        enqueue(binding, subject);
    }
  }

  for (const { binding, variantId } of queue) {
    const { policy } = binding;
    let result: RuleResultV2 | null;
    if (policy.route === 'option_cases') {
      const selected = selectOptionCaseV2(policy, family, values, variantId);
      result = selected?.result ?? null;
      if (selected) {
        // Identity lookup in the same admitted policy, never a second matcher.
        const selectedCase = policy.cases.find(
          (item) => item.code === selected.caseCode,
        )!;
        for (const dependency of selectedCase.when) {
          enqueue(bindings.get(dependency.definitionCode)!, variantId);
        }
      }
    } else {
      const facts =
        policy.route === 'fact_rule'
          ? (qualifiedFactsBySubject.get(variantId) ?? {})
          : {};
      result = evaluateBindingPolicyV2(
        policy,
        family,
        values,
        variantId,
        facts,
      );
    }
    entries.push({ code: binding.definitionCode, variantId, result });
  }
  return entries;
}
