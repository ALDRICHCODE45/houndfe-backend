import type { DefinitionV2 } from './editorial-vocabulary-definition-v2';
import type { FamilyV2 } from './editorial-vocabulary-family-shape-v2';

/**
 * Dormant declaration check, not full vocabulary/publication admission.
 * Requires a parsed family, validated unique definitions keyed by actual IDs,
 * checked references and stable inputs throughout this synchronous assertion.
 * Pending classifies legacy metadata; it does not prove publication safety.
 */
export function assertFamilyLegacyCompatibilityV2(
  family: FamilyV2,
  definitionsById: ReadonlyMap<string, DefinitionV2>,
): void {
  if (family.minimumContractVersion === 2) return;
  for (const binding of family.bindings) {
    const definition = definitionsById.get(binding.definitionId)!;
    if (
      binding.policy.route !== 'pending' ||
      definition.type === 'range' ||
      (definition.type === 'number' &&
        definition.numericPolicy.status !== 'pending')
    ) {
      throw new TypeError('Expected a legacy-compatible family V2');
    }
  }
}
