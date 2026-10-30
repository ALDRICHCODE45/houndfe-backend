import { assertFreshNumericPayloadV2 } from './editorial-numeric-payload-v2';
import type { ValueV2 } from './editorial-value-shape-v2';
import type { DefinitionV2 } from './editorial-vocabulary-definition-v2';
import type { FamilyV2 } from './editorial-vocabulary-family-shape-v2';

/** Every supplied numeric assertion; stable reference-admitted inputs only. */
export function assertFreshNumericAdmissionV2(
  values: readonly ValueV2[],
  family: FamilyV2,
  definitions: ReadonlyMap<string, DefinitionV2>,
  operation: 'save' | 'publish',
): void {
  for (const value of values) {
    if (value.state !== 'known') continue;
    const payload = value.payload;
    if (payload.type !== 'number' && payload.type !== 'range') continue;
    const binding = family.bindings.find(
      (item) => item.definitionCode === value.code,
    );
    const definition = binding && definitions.get(binding.definitionId);
    if (
      !definition ||
      (definition.type !== 'number' && definition.type !== 'range')
    )
      throw new TypeError('Expected admitted numeric inputs');
    assertFreshNumericPayloadV2(payload, definition.numericPolicy, operation);
  }
}
