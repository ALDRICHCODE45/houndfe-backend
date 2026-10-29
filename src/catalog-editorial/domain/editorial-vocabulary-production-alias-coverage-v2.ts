import { editorialAliasComparisonKeyV1 as comparisonKey } from './editorial-alias-comparison-v1';
import { ALIASES } from './editorial-production-choice-inventory';
import { isProductionFamily } from './editorial-production-vocabulary-catalog';
import type { DefinitionV2 } from './editorial-vocabulary-definition-v2';
import type { FamilyV2 } from './editorial-vocabulary-family-shape-v2';
import { assertProductionChoiceCoverageV2 } from './editorial-vocabulary-production-choice-coverage-v2';

/**
 * Dormant assertion for fresh, trusted candidates; not admission or adoption.
 * Caller parses family, validates unique definitions indexed by actual IDs,
 * checks references and keeps inputs stable throughout this synchronous call.
 * Definition-local collision validation remains a caller precondition.
 */
export function assertProductionAliasCoverageV2(
  family: FamilyV2,
  definitionsById: ReadonlyMap<string, DefinitionV2>,
): void {
  assertProductionChoiceCoverageV2(family, definitionsById);
  if (!isProductionFamily(family.code)) return;
  for (const binding of family.bindings) {
    if (binding.definitionCode !== 'animal.target') continue;
    const definition = definitionsById.get(binding.definitionId)!;
    // The composition guarantees the resolved canonical choice type.
    if (definition.type !== 'single' && definition.type !== 'multi') continue;
    // Compare at use, never at module load: preserve the Unicode17 runtime guard.
    const actual = definition.aliases.map((alias) => ({
      key: comparisonKey(alias.label),
      optionCode: alias.optionCode,
    }));
    for (const [label, optionCode] of ALIASES) {
      const key = comparisonKey(label);
      if (
        !actual.some(
          (alias) => alias.key === key && alias.optionCode === optionCode,
        )
      )
        throw new TypeError('Expected production alias coverage V2');
    }
  }
}
