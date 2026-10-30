import { fail } from './document';
import type { FactInputsV2 } from './editorial-fact-rule-evaluation-v2';

/** One caller-selected subject; reference admission and qualification are preconditions. */
export function assertToyDeterminationAgreementV2(
  selectedToyTypes: readonly string[],
  determination:
    | Readonly<NonNullable<FactInputsV2['relevantDimensionCodes']>>
    | null
    | undefined,
): void {
  if (determination == null) fail('MALFORMED');
  const coveredTypes = determination.toyTypes;
  const selectedTypes = new Set(selectedToyTypes);
  if (
    coveredTypes.length !== selectedToyTypes.length ||
    !coveredTypes.every((code) => selectedTypes.has(code))
  )
    fail('MALFORMED');
}
