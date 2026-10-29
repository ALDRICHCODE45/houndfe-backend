import type { KnownPayloadV2 } from './editorial-known-payload-shape-v2';
import type { NumericPolicyV2 } from './editorial-vocabulary-numeric-v2';

/** Fresh domain only: parsed finite payload, validated policy and membership. */
export function assertFreshNumericPayloadV2(
  payload: Extract<KnownPayloadV2, { type: 'number' | 'range' }>,
  policy: NumericPolicyV2,
  operation: 'save' | 'publish',
): void {
  if (payload.type === 'range' && payload.min > payload.max)
    throw new Error('MALFORMED');
  if (policy.status === 'pending') {
    if (operation === 'publish') throw new Error('MALFORMED');
    return;
  }
  const values =
    payload.type === 'number' ? [payload.value] : [payload.min, payload.max];
  for (const value of values) {
    if (
      (policy.integer && !Number.isInteger(value)) ||
      (policy.lower !== null &&
        (value < policy.lower ||
          (value === policy.lower && !policy.lowerInclusive))) ||
      (policy.upper !== null &&
        (value > policy.upper ||
          (value === policy.upper && !policy.upperInclusive)))
    )
      throw new Error('MALFORMED');
  }
}
