import type { FactInputsV2 } from './editorial-fact-rule-evaluation-v2';
import { assertFreshFactsCaptureV2 } from './editorial-facts-capture-v2';
import { assertFreshFactsReferencesV2 } from './editorial-facts-references-v2';
import type { SellableFactsShapeV2 } from './editorial-sellable-facts-shape-v2';
import type { DefinitionV2 } from './editorial-vocabulary-definition-v2';
import type { FamilyV2 } from './editorial-vocabulary-family-shape-v2';

/** Stable parsed row and coherent admitted metadata; not publication readiness. */
export function qualifyFactsV2(
  parsedRow: SellableFactsShapeV2,
  admittedFamily: FamilyV2,
  coherentDefinitionsMap: ReadonlyMap<string, DefinitionV2>,
): FactInputsV2 {
  assertFreshFactsCaptureV2(parsedRow);
  assertFreshFactsReferencesV2(
    parsedRow,
    admittedFamily,
    coherentDefinitionsMap,
  );
  const result: FactInputsV2 = {};
  for (const declaration of parsedRow.declarations) {
    if (declaration.state === 'unknown') continue;
    const value = declaration.value;
    const detached = Array.isArray(value)
      ? [...value]
      : typeof value === 'object'
        ? { codes: [...value.codes], toyTypes: [...value.toyTypes] }
        : value;
    // The declaration union preserves the key/value pairing through this copy.
    Object.assign(result, { [declaration.key]: detached });
  }
  return result;
}
