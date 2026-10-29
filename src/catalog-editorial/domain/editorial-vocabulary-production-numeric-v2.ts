import {
  isProductionFamily,
  NUMBERS,
} from './editorial-production-vocabulary-catalog';
import type { DefinitionV2 } from './editorial-vocabulary-definition-v2';
import type { FamilyV2 } from './editorial-vocabulary-family-shape-v2';
import { assertProductionBindingPoliciesV2 } from './editorial-vocabulary-production-policy-v2';

// Private projection of the existing normative rows, not a second numeric inventory.
const expectedByCode = new Map<
  string,
  {
    type: 'number' | 'range';
    units: ReadonlySet<string>;
    integer: boolean;
    lower: 0 | null;
  }
>(
  NUMBERS.map(([code, type, units, , domain]) => [
    code,
    {
      type,
      units: new Set(units.split(',')),
      integer: domain === 'I',
      lower: domain === 'F' ? null : 0,
    },
  ]),
);

function invalid(): never {
  throw new TypeError('Expected production numeric definitions V2');
}

/**
 * Fresh explicitly production candidates only; never legacy adoption authority.
 * Caller parses family, validates unique definitions indexed by actual IDs and
 * checks family references. Stable inputs required; success is void, not admission.
 */
export function assertProductionNumericDefinitionsV2(
  family: FamilyV2,
  definitionsById: ReadonlyMap<string, DefinitionV2>,
): void {
  assertProductionBindingPoliciesV2(family);
  if (!isProductionFamily(family.code)) return;
  for (const binding of family.bindings) {
    const expected = expectedByCode.get(binding.definitionCode);
    if (!expected) continue;
    const d = definitionsById.get(binding.definitionId);
    if (
      !d ||
      d.code !== binding.definitionCode ||
      (d.type !== 'number' && d.type !== 'range') ||
      d.type !== expected.type
    )
      invalid();
    // Generic validation already guarantees unique unit codes: cardinality + membership = equality.
    if (
      d.units.length !== expected.units.size ||
      d.units.some((u) => u.code === null || !expected.units.has(u.code))
    )
      invalid();
    const p = d.numericPolicy;
    if (
      p.status !== 'resolved' ||
      p.magnitude !== binding.definitionCode ||
      p.integer !== expected.integer ||
      p.lower !== expected.lower ||
      p.lowerInclusive !== false ||
      p.upper !== null ||
      p.upperInclusive !== false
    )
      invalid();
  }
}
