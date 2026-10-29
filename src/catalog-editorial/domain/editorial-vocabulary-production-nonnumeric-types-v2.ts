import {
  CHOICES,
  isProductionFamily,
  OTHER,
} from './editorial-production-vocabulary-catalog';
import type { DefinitionV2 } from './editorial-vocabulary-definition-v2';
import type { FamilyV2 } from './editorial-vocabulary-family-shape-v2';
import { assertProductionBindingPoliciesV2 } from './editorial-vocabulary-production-policy-v2';

// Private projection of existing normative rows, not another code inventory.
const expectedByCode: ReadonlyMap<string, DefinitionV2['type']> = new Map(
  [...CHOICES, ...OTHER].map(([code, type]) => [code, type]),
);

/**
 * Fresh explicitly production candidates only; not legacy adoption authority.
 * Caller parses family, validates unique definitions indexed by actual IDs and
 * checks references. Stable inputs required; void success is not admission.
 */
export function assertProductionNonnumericDefinitionTypesV2(
  family: FamilyV2,
  definitionsById: ReadonlyMap<string, DefinitionV2>,
): void {
  assertProductionBindingPoliciesV2(family);
  if (!isProductionFamily(family.code)) return;
  for (const binding of family.bindings) {
    const expected = expectedByCode.get(binding.definitionCode);
    if (!expected) continue;
    const definition = definitionsById.get(binding.definitionId);
    if (
      !definition ||
      definition.code !== binding.definitionCode ||
      definition.type !== expected
    )
      throw new TypeError('Expected production nonnumeric definition types V2');
  }
}
