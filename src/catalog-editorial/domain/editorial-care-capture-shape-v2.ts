import { EditorialDocumentShapeError } from './editorial-document-shape-error';
import {
  parseCareRequirementShapeV2,
  parseCareWarningShapeV2,
  type CareRequirementV2,
  type CareWarningV2,
} from './editorial-care-entry-shape-v2';
import { parseEvidenceShapeV2, type EvidenceV2 } from './editorial-evidence-v2';

export type CareReviewCaptureV2 =
  | { state: 'unknown' }
  | {
      state: 'prepared';
      jurisdiction: string;
      intendedUse: string;
      determination: 'identified' | 'none_applicable';
      evidence: EvidenceV2[];
      basis: string;
      requirements: CareRequirementV2[];
      warnings: CareWarningV2[];
    };

function invalid(): never {
  throw new EditorialDocumentShapeError('Expected a care capture shape V2');
}

function array<T>(input: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype)
    invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input as object);
  const length = descriptors.length.value as number;
  if (Reflect.ownKeys(descriptors).length !== length + 1) invalid();
  const result: T[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[index];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
      invalid();
    result.push(parse(descriptor.value));
  }
  return result;
}

/** Pre-receipt primitive capture shape, never care validity or approval. */
export function parseCareCaptureShapeV2(input: unknown): CareReviewCaptureV2 {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const state = descriptors.state;
  if (!state || !state.enumerable || !('value' in state)) invalid();
  if (state.value === 'unknown') {
    if (Reflect.ownKeys(descriptors).length !== 1) invalid();
    return { state: 'unknown' };
  }
  if (state.value !== 'prepared') invalid();
  const keys = [
    'state',
    'jurisdiction',
    'intendedUse',
    'determination',
    'evidence',
    'basis',
    'requirements',
    'warnings',
  ];
  if (Reflect.ownKeys(descriptors).length !== keys.length) invalid();
  const data: Record<string, unknown> = {};
  for (const key of keys) {
    if (!Object.hasOwn(descriptors, key)) invalid();
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !('value' in descriptor)) invalid();
    data[key] = descriptor.value;
  }
  const { jurisdiction, intendedUse, determination, basis } = data;
  if (
    typeof jurisdiction !== 'string' ||
    typeof intendedUse !== 'string' ||
    typeof basis !== 'string' ||
    (determination !== 'identified' && determination !== 'none_applicable')
  )
    invalid();
  return {
    state: 'prepared',
    jurisdiction,
    intendedUse,
    determination,
    evidence: array(data.evidence, parseEvidenceShapeV2),
    basis,
    requirements: array(data.requirements, parseCareRequirementShapeV2),
    warnings: array(data.warnings, parseCareWarningShapeV2),
  };
}
