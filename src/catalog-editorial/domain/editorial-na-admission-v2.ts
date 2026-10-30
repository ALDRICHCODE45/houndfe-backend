import { fail } from './document';
import { evaluateBindingPolicyV2 } from './editorial-binding-policy-evaluation-v2';
import type { FactInputsV2 } from './editorial-fact-rule-evaluation-v2';
import type { FamilyV2 } from './editorial-vocabulary-family-shape-v2';
import type { ValueV2 } from './editorial-value-shape-v2';

/** Fresh explicit-NA permission over stable reference-admitted, qualified inputs. */
export function assertFreshNAAdmissionV2(
  values: readonly ValueV2[],
  family: FamilyV2,
  qualifiedFactsBySubject: ReadonlyMap<string | null, FactInputsV2>,
): void {
  for (const value of values) {
    if (value.state !== 'not_applicable') continue;
    const binding = family.bindings.find(
      (item) => item.definitionCode === value.code,
    );
    if (!binding) fail('MALFORMED');
    const facts =
      binding.policy.route === 'fact_rule'
        ? (qualifiedFactsBySubject.get(value.variantId) ?? {})
        : {};
    const selected = evaluateBindingPolicyV2(
      binding.policy,
      family,
      values,
      value.variantId,
      facts,
    );
    if (
      selected === null ||
      selected.applicability !== 'not_applicable' ||
      selected.allowNA !== true
    )
      fail('MALFORMED');
  }
}
