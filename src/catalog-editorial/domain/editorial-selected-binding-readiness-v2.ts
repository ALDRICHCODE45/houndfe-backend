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

/** Local readiness over a stable admitted selection and matching parsed value. */
export function assertSelectedBindingReadinessV2(
  selected: RuleResultV2 | null,
  value: ValueV2 | undefined,
): void {
  if (
    selected === null ||
    selected.applicability === 'unresolved' ||
    selected.documentary === 'unresolved'
  )
    fail('MALFORMED');
  if (
    selected.required &&
    (selected.applicability !== 'applicable' ||
      value?.state !== 'known' ||
      !hasRequiredPresence(value.payload))
  )
    fail('MALFORMED');
  if (value?.state === 'not_applicable') {
    if (selected.applicability !== 'not_applicable' || !selected.allowNA)
      fail('MALFORMED');
    return;
  }
  if (value?.state !== 'known') return;
  if (selected.applicability === 'not_applicable') fail('MALFORMED');
  if (value.evidence === null) {
    if (selected.evidenceRequired) fail('MALFORMED');
  } else if (!isFreshEvidenceV2(value.evidence)) fail('MALFORMED');
}
