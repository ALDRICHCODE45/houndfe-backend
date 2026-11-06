import {
  evaluateFactRuleV2,
  type FactInputsV2,
} from './editorial-fact-rule-evaluation-v2';
import {
  evaluateOptionCasesV2,
  type RuleResultV2,
} from './editorial-option-case-evaluation-v2';
import type { FamilyV2 } from './editorial-vocabulary-family-shape-v2';
import type { BindingPolicy } from './editorial-vocabulary-policy-shape-v2';
import type { ValueV2 } from './editorial-value-shape-v2';

/** The subject's selected `accessory.type` codes; empty when unknown or absent. */
function selectedAccessoryTypes(
  family: FamilyV2,
  values: readonly ValueV2[],
  subjectVariantId: string | null,
): readonly string[] {
  const binding = family.bindings.find(
    (b) => b.definitionCode === 'accessory.type',
  );
  if (!binding) return [];
  const variantId = binding.owner === 'product' ? null : subjectVariantId;
  const value = values.find(
    (v) => v.code === 'accessory.type' && v.variantId === variantId,
  );
  if (value?.state !== 'known') return [];
  const { payload } = value;
  return payload.type === 'single'
    ? [payload.value]
    : payload.type === 'multi'
      ? payload.value
      : [];
}

/** Exclusive dispatch over stable admitted inputs, not publication admission. */
export function evaluateBindingPolicyV2(
  policy: BindingPolicy,
  family: FamilyV2,
  values: readonly ValueV2[],
  subjectVariantId: string | null,
  qualifiedFactInputs: Readonly<FactInputsV2>,
): RuleResultV2 | null {
  switch (policy.route) {
    case 'pending':
      return null;
    case 'option_cases':
      return evaluateOptionCasesV2(policy, family, values, subjectVariantId);
    case 'fact_rule':
      // Only accessory rules read the subject's values (D8 per-type defaults).
      return policy.rule.family === 'accessory'
        ? evaluateFactRuleV2(
            policy.rule,
            qualifiedFactInputs,
            selectedAccessoryTypes(family, values, subjectVariantId),
          )
        : evaluateFactRuleV2(policy.rule, qualifiedFactInputs);
  }
}
