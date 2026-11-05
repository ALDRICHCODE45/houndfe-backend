import { fail } from './document';
import type { FactInputsV2 } from './editorial-fact-rule-evaluation-v2';
import type { ValueV2 } from './editorial-value-shape-v2';

const magnitudes = new Map<
  string,
  NonNullable<FactInputsV2['contentMagnitude']>
>([
  ['content.kind.mass', 'mass'],
  ['content.kind.volume', 'volume'],
  ['content.kind.count', 'count'],
  ['content.kind.length', 'length'],
  ['content.kind.area', 'area'],
]);

/** The S52 agreement rule: unknown magnitude is UNRESOLVED, a disagreement is MAGNITUDE_MISMATCH. */
export function contentKindAgreementProblemV2(
  kind: ValueV2 | undefined,
  contentMagnitude: FactInputsV2['contentMagnitude'],
): 'UNRESOLVED' | 'MAGNITUDE_MISMATCH' | null {
  if (kind?.state !== 'known') return null;
  if (kind.payload.type !== 'single')
    throw new TypeError('Expected admitted content-kind inputs');
  const expectedMagnitude = magnitudes.get(kind.payload.value);
  if (expectedMagnitude === undefined) return 'MAGNITUDE_MISMATCH';
  if (contentMagnitude == null) return 'UNRESOLVED';
  return contentMagnitude === expectedMagnitude ? null : 'MAGNITUDE_MISMATCH';
}

/** Stable parsed/reference-admitted assignment and matching qualified fact only. */
export function assertContentKindAgreementV2(
  kind: ValueV2 | undefined,
  contentMagnitude: FactInputsV2['contentMagnitude'],
): void {
  if (contentKindAgreementProblemV2(kind, contentMagnitude) !== null)
    fail('MALFORMED');
}
