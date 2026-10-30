import type { FamilyV2 } from './editorial-vocabulary-family-shape-v2';
import type {
  BindingPolicy,
  PolicyCase,
} from './editorial-vocabulary-policy-shape-v2';
import type { ValueV2 } from './editorial-value-shape-v2';

export type RuleResultV2 = Pick<
  PolicyCase,
  'applicability' | 'required' | 'allowNA' | 'evidenceRequired' | 'documentary'
>;

/** Admitted, stable metadata/values only; selection is not publication admission. */
export function evaluateOptionCasesV2(
  policy: Extract<BindingPolicy, { route: 'option_cases' }>,
  family: FamilyV2,
  values: readonly ValueV2[],
  subjectVariantId: string | null,
): RuleResultV2 | null {
  let selected: PolicyCase | null = null;
  for (const candidate of policy.cases) {
    const matches = candidate.when.every((test) => {
      const binding = family.bindings.find(
        (item) => item.definitionCode === test.definitionCode,
      );
      if (!binding) throw new TypeError('Expected admitted option-case inputs');
      const variantId = binding.owner === 'product' ? null : subjectVariantId;
      const value = values.find(
        (item) =>
          item.code === test.definitionCode && item.variantId === variantId,
      );
      if (!value || value.state !== 'known') return false;
      const payload = value.payload;
      if (payload.type !== 'single' && payload.type !== 'multi')
        throw new TypeError('Expected admitted option-case inputs');
      const actual = new Set(
        payload.type === 'single' ? [payload.value] : payload.value,
      );
      if (test.operator === 'intersects')
        return test.optionCodes.some((code) => actual.has(code));
      const containsAll = test.optionCodes.every((code) => actual.has(code));
      return (
        containsAll &&
        (test.operator === 'contains_all' ||
          actual.size === test.optionCodes.length)
      );
    });
    if (!matches) continue;
    if (selected !== null) return null;
    selected = candidate;
  }
  if (selected === null) return null;
  return {
    applicability: selected.applicability,
    required: selected.required,
    allowNA: selected.allowNA,
    evidenceRequired: selected.evidenceRequired,
    documentary: selected.documentary,
  };
}
