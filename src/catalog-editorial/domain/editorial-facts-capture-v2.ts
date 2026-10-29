import { isFreshEvidenceV2 } from './editorial-evidence-v2';
import type { SellableFactsShapeV2 } from './editorial-sellable-facts-shape-v2';

function malformed(): never {
  throw new Error('MALFORMED');
}

function assertProse(text: string, maximum: number): void {
  if (text.trim().length === 0) malformed();
  let count = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (++count > maximum || (code >= 0xd800 && code <= 0xdfff)) malformed();
  }
}

function assertLocalSet(codes: string[], maximum: number): void {
  if (codes.length > maximum || new Set(codes).size !== codes.length)
    malformed();
}

/** Fresh capture bounds only, after successful row shape parsing. */
export function assertFreshFactsCaptureV2(row: SellableFactsShapeV2): void {
  assertProse(row.presentation, 300);
  if (row.declarations.length > 12) malformed();
  const keys = new Set<string>();
  for (const declaration of row.declarations) {
    if (keys.has(declaration.key)) malformed();
    keys.add(declaration.key);
    if (declaration.state === 'unknown') continue;
    assertProse(declaration.basis, 2000);
    if (!isFreshEvidenceV2(declaration.evidence)) malformed();
    switch (declaration.key) {
      case 'relevantDimensionCodes':
        assertLocalSet(declaration.value.codes, 8);
        assertLocalSet(declaration.value.toyTypes, 15);
        break;
      case 'relevantFitCodes':
        assertLocalSet(declaration.value, 3);
        break;
      case 'relevantCapacityCodes':
        assertLocalSet(declaration.value, 2);
        break;
      case 'relevantEquipmentCodes':
        assertLocalSet(declaration.value, 5);
        break;
      case 'optionalNonpertinenceCodes':
        assertLocalSet(declaration.value, 68);
        break;
    }
  }
}
