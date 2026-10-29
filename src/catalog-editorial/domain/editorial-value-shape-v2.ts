import {
  parseKnownPayloadShapeV2,
  type KnownPayloadV2,
} from './editorial-known-payload-shape-v2';
import { parseEvidenceShapeV2, type EvidenceV2 } from './editorial-evidence-v2';

type Key = {
  code: string;
  owner: 'product' | 'sellable';
  variantId: string | null;
};
export type ValueV2 = Key &
  (
    | { state: 'known'; payload: KnownPayloadV2; evidence: EvidenceV2 | null }
    | { state: 'unknown'; evidence: null }
    | { state: 'not_applicable'; evidence: null }
  );

function invalid(): never {
  throw new TypeError('Expected a value shape V2');
}

/** Closed pre-receipt shape only, not relational or fresh admission. */
export function parseValueShapeV2(input: unknown): ValueV2 {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  // Inspect descriptors before reading any submitted values; never invoke getters.
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') invalid();
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !('value' in descriptor)) invalid();
  }
  const data = descriptors as Record<string, { value: unknown }>;
  const state = data.state?.value;
  if (state !== 'known' && state !== 'unknown' && state !== 'not_applicable')
    invalid();
  const keys = ['code', 'owner', 'variantId', 'state', 'evidence'];
  if (state === 'known') keys.push('payload');
  if (
    Object.keys(data).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(data, key))
  )
    invalid();
  const code = data.code.value;
  const owner = data.owner.value;
  const variantId = data.variantId.value;
  const evidence = data.evidence.value;
  if (
    typeof code !== 'string' ||
    (owner !== 'product' && owner !== 'sellable') ||
    (variantId !== null && typeof variantId !== 'string')
  )
    invalid();
  if (state === 'known') {
    return {
      code,
      owner,
      variantId,
      state,
      payload: parseKnownPayloadShapeV2(data.payload.value),
      evidence: evidence === null ? null : parseEvidenceShapeV2(evidence),
    };
  }
  if (evidence !== null) invalid();
  return { code, owner, variantId, state, evidence: null };
}
