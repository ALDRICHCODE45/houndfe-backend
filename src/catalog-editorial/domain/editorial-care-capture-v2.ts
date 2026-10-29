import type { CareReviewCaptureV2 } from './editorial-care-capture-shape-v2';
import { isFreshEvidenceV2, type EvidenceV2 } from './editorial-evidence-v2';

function invalid(): never {
  throw new Error('MALFORMED');
}

function prose(value: string, maximum: number): void {
  if (value.trim().length === 0) invalid();
  let count = 0;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (++count > maximum || (code >= 0xd800 && code <= 0xdfff)) invalid();
  }
}

function evidence(items: EvidenceV2[]): void {
  if (items.length > 16) invalid();
  const datesBySource = new Map<string, Set<string>>();
  for (const item of items) {
    if (!isFreshEvidenceV2(item)) invalid();
    const dates = datesBySource.get(item.sourceRef) ?? new Set<string>();
    if (dates.has(item.verifiedOn)) invalid();
    dates.add(item.verifiedOn);
    datesBySource.set(item.sourceRef, dates);
  }
}

function entryKeys(items: { key: string }[]): Set<string> {
  if (items.length > 32) invalid();
  const keys = new Set<string>();
  for (const item of items) {
    prose(item.key, 80);
    if (keys.has(item.key)) invalid();
    keys.add(item.key);
  }
  return keys;
}

/** Fresh parsed capture only, never publication approval or historical replay. */
export function assertFreshCareCaptureV2(review: CareReviewCaptureV2): void {
  if (review.state === 'unknown') return;
  prose(review.jurisdiction, 200);
  prose(review.intendedUse, 1000);
  prose(review.basis, 2000);
  evidence(review.evidence);
  const requirements = entryKeys(review.requirements);
  entryKeys(review.warnings);
  for (const requirement of review.requirements) {
    prose(requirement.description, 2000);
    prose(requirement.basis, 2000);
    evidence(requirement.evidence);
  }
  for (const warning of review.warnings) {
    prose(warning.text, 4000);
    prose(warning.handlingBasis, 2000);
    evidence(warning.evidence);
    if (warning.requirementKeys.length > 32) invalid();
    const references = new Set<string>();
    for (const key of warning.requirementKeys) {
      if (references.has(key) || !requirements.has(key)) invalid();
      references.add(key);
    }
  }
}
