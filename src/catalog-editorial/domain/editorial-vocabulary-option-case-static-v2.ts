import { EditorialVocabularyRepresentationError } from './editorial-vocabulary-representation-error';
import type { DefinitionV2 } from './editorial-vocabulary-definition-v2';
import type { FamilyV2 } from './editorial-vocabulary-family-shape-v2';
import type { OptionTest } from './editorial-vocabulary-policy-shape-v2';

function invalid(reason: string): never {
  throw new EditorialVocabularyRepresentationError(
    `Invalid family option cases V2: ${reason}`,
  );
}
function sharedValuePossible(
  a: OptionTest,
  b: OptionTest,
  single: boolean,
): boolean {
  const expected = new Set(a.optionCodes);
  const intersects = b.optionCodes.some((code) => expected.has(code));
  // After individual checks, every single predicate allows exactly its listed
  // singleton values (equals_set/contains_all necessarily have size one).
  if (single) return intersects;
  if (a.operator !== 'equals_set' && b.operator !== 'equals_set') {
    // Positive requirements can always coexist in their union.
    return true;
  }
  if (a.operator !== 'equals_set') return sharedValuePossible(b, a, false);
  if (b.operator === 'intersects') return intersects;
  const contains = b.optionCodes.every((code) => expected.has(code));
  return (
    contains &&
    (b.operator !== 'equals_set' || expected.size === b.optionCodes.length)
  );
}

/**
 * Dormant trusted-input assertion, not parsing or full admission. Caller must
 * parse the family, validate all definitions, establish unique IDs/codes, index
 * by actual IDs, and pass reference and policy-consistency checks first.
 * Inputs must remain stable throughout this synchronous, nonmutating check.
 */
export function assertFamilyOptionCaseStaticV2(
  family: FamilyV2,
  definitionsById: ReadonlyMap<string, DefinitionV2>,
): void {
  const singleByCode = new Map(
    family.bindings.map((binding) => [
      binding.definitionCode,
      definitionsById.get(binding.definitionId)!.type === 'single',
    ]),
  );
  for (const binding of family.bindings) {
    if (binding.policy.route !== 'option_cases') continue;
    const cases = binding.policy.cases;
    // Reject impossible cases even when alone, before considering any pair.
    for (const policyCase of cases) {
      for (const test of policyCase.when) {
        if (
          singleByCode.get(test.definitionCode) &&
          test.operator !== 'intersects' &&
          test.optionCodes.length !== 1
        ) {
          invalid(
            `impossible case ${policyCase.code} in ${binding.definitionCode}`,
          );
        }
      }
    }
    // Shape guarantees at most one predicate per selector in each case.
    const testsByCase = cases.map(
      (policyCase) =>
        new Map(policyCase.when.map((test) => [test.definitionCode, test])),
    );
    for (let i = 0; i < cases.length; i += 1) {
      for (let j = i + 1; j < cases.length; j += 1) {
        const overlap = cases[i].when.every((test) => {
          const other = testsByCase[j].get(test.definitionCode);
          return (
            !other ||
            sharedValuePossible(
              test,
              other,
              singleByCode.get(test.definitionCode)!,
            )
          );
        });
        if (overlap) {
          invalid(
            `overlap ${cases[i].code}/${cases[j].code} in ${binding.definitionCode}`,
          );
        }
      }
    }
  }
}
