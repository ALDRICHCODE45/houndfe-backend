import { fail } from './document';
import type { FactInputsV2 } from './editorial-fact-rule-evaluation-v2';

/** True when a known negative relevance comes with a nonempty subset. */
export function hasFactConflictV2(facts: Readonly<FactInputsV2>): boolean {
  return (
    (facts.fitDeterminesChoice === false &&
      (facts.relevantFitCodes?.length ?? 0) > 0) ||
    (facts.capacityDeterminesChoice === false &&
      (facts.relevantCapacityCodes?.length ?? 0) > 0) ||
    (facts.electricalApplies === false &&
      (facts.relevantEquipmentCodes?.length ?? 0) > 0)
  );
}

/** One publication subject's stable qualified facts; not completeness admission. */
export function assertFactConsistencyV2(facts: Readonly<FactInputsV2>): void {
  if (hasFactConflictV2(facts)) fail('MALFORMED');
}
