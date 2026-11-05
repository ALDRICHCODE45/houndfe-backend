import type { KnownPayloadV2 } from './editorial-known-payload-shape-v2';
import type { NumericPolicyV2 } from './editorial-vocabulary-numeric-v2';

export type NumericPayloadProblemV2 =
  | 'INVALID_VALUE'
  | 'NUMERIC_POLICY_PENDING';

/** The fresh numeric rule: the payload's problem, or null when admitted. */
export function freshNumericPayloadProblemV2(
  payload: Extract<KnownPayloadV2, { type: 'number' | 'range' }>,
  policy: NumericPolicyV2,
  operation: 'save' | 'publish',
): NumericPayloadProblemV2 | null {
  if (payload.type === 'range' && payload.min > payload.max)
    return 'INVALID_VALUE';
  if (policy.status === 'pending')
    return operation === 'publish' ? 'NUMERIC_POLICY_PENDING' : null;
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
      return 'INVALID_VALUE';
  }
  return null;
}

/** Fresh domain only: parsed finite payload, validated policy and membership. */
export function assertFreshNumericPayloadV2(
  payload: Extract<KnownPayloadV2, { type: 'number' | 'range' }>,
  policy: NumericPolicyV2,
  operation: 'save' | 'publish',
): void {
  if (freshNumericPayloadProblemV2(payload, policy, operation) !== null)
    throw new Error('MALFORMED');
}
