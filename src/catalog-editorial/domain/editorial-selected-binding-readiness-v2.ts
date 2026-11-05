import { fail } from './document';
import { isFreshEvidenceV2 } from './editorial-evidence-v2';
import type { KnownPayloadV2 } from './editorial-known-payload-shape-v2';
import type { RuleResultV2 } from './editorial-option-case-evaluation-v2';
import type { ValueV2 } from './editorial-value-shape-v2';

function hasRequiredPresence(payload: KnownPayloadV2): boolean {
  switch (payload.type) {
    case 'text':
      return payload.value.trim().length > 0;
    case 'single':
    case 'multi':
      return payload.value.length > 0;
    case 'boolean':
    case 'number':
    case 'range':
      return true;
  }
}

export type SelectedBindingProblemV2 =
  | 'UNRESOLVED'
  | 'REQUIRED_MISSING'
  | 'NA_NOT_ALLOWED'
  | 'NOT_APPLICABLE_VALUE'
  | 'EVIDENCE_REQUIRED';

/** The local readiness rule: the first problem of one selection, or null when ready. */
export function selectedBindingProblemV2(
  selected: RuleResultV2 | null,
  value: ValueV2 | undefined,
): SelectedBindingProblemV2 | null {
  if (
    selected === null ||
    selected.applicability === 'unresolved' ||
    selected.documentary === 'unresolved'
  )
    return 'UNRESOLVED';
  if (
    selected.required &&
    (selected.applicability !== 'applicable' ||
      value?.state !== 'known' ||
      !hasRequiredPresence(value.payload))
  )
    return value?.state === 'not_applicable'
      ? 'NA_NOT_ALLOWED'
      : 'REQUIRED_MISSING';
  if (value?.state === 'not_applicable') {
    if (selected.applicability !== 'not_applicable' || !selected.allowNA)
      return 'NA_NOT_ALLOWED';
    return null;
  }
  if (value?.state !== 'known') return null;
  if (selected.applicability === 'not_applicable')
    return 'NOT_APPLICABLE_VALUE';
  if (value.evidence === null) {
    if (selected.evidenceRequired) return 'EVIDENCE_REQUIRED';
  } else if (!isFreshEvidenceV2(value.evidence)) return 'EVIDENCE_REQUIRED';
  return null;
}

/** Local readiness over a stable admitted selection and matching parsed value. */
export function assertSelectedBindingReadinessV2(
  selected: RuleResultV2 | null,
  value: ValueV2 | undefined,
): void {
  if (selectedBindingProblemV2(selected, value) !== null) fail('MALFORMED');
}
