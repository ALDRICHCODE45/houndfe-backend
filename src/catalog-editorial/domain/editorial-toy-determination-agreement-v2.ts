import { fail } from './document';
import type { FactInputsV2 } from './editorial-fact-rule-evaluation-v2';

type Determination =
  | Readonly<NonNullable<FactInputsV2['relevantDimensionCodes']>>
  | null
  | undefined;

/** The toy agreement rule: a missing determination is UNRESOLVED, other types a mismatch. */
export function toyDeterminationProblemV2(
  selectedToyTypes: readonly string[],
  determination: Determination,
): 'UNRESOLVED' | 'TOY_TYPES_MISMATCH' | null {
  if (determination == null) return 'UNRESOLVED';
  const coveredTypes = determination.toyTypes;
  const selectedTypes = new Set(selectedToyTypes);
  if (
    coveredTypes.length !== selectedToyTypes.length ||
    !coveredTypes.every((code) => selectedTypes.has(code))
  )
    return 'TOY_TYPES_MISMATCH';
  return null;
}

/** One caller-selected subject; reference admission and qualification are preconditions. */
export function assertToyDeterminationAgreementV2(
  selectedToyTypes: readonly string[],
  determination: Determination,
): void {
  if (toyDeterminationProblemV2(selectedToyTypes, determination) !== null)
    fail('MALFORMED');
}
