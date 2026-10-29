import { parseEvidenceShapeV2, type EvidenceV2 } from './editorial-evidence-v2';

export type CareRequirementV2 = {
  key: string;
  description: string;
  disposition: 'satisfied' | 'not_applicable' | 'unresolved' | 'conflicting';
  evidence: EvidenceV2[];
  basis: string;
};
export type CareWarningV2 = {
  key: string;
  requirementKeys: string[];
  text: string;
  disclosure: 'private_only' | 'public_required' | 'unresolved';
  evidence: EvidenceV2[];
  handlingBasis: string;
};

function invalid(): never {
  throw new TypeError('Expected a care entry shape V2');
}

function fields(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(descriptors).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(descriptors, key))
  )
    invalid();
  const data: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !('value' in descriptor)) invalid();
    data[key] = descriptor.value;
  }
  return data;
}

function string(input: unknown): string {
  if (typeof input !== 'string') invalid();
  return input;
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

/** Primitive pre-receipt shape, not fresh care validity or permission. */
export function parseCareRequirementShapeV2(input: unknown): CareRequirementV2 {
  const data = fields(input, [
    'key',
    'description',
    'disposition',
    'evidence',
    'basis',
  ]);
  const disposition = data.disposition;
  if (
    disposition !== 'satisfied' &&
    disposition !== 'not_applicable' &&
    disposition !== 'unresolved' &&
    disposition !== 'conflicting'
  )
    invalid();
  return {
    key: string(data.key),
    description: string(data.description),
    disposition,
    evidence: array(data.evidence, parseEvidenceShapeV2),
    basis: string(data.basis),
  };
}

/** Private warning shape only; public_required is not publication approval. */
export function parseCareWarningShapeV2(input: unknown): CareWarningV2 {
  const data = fields(input, [
    'key',
    'requirementKeys',
    'text',
    'disclosure',
    'evidence',
    'handlingBasis',
  ]);
  const disclosure = data.disclosure;
  if (
    disclosure !== 'private_only' &&
    disclosure !== 'public_required' &&
    disclosure !== 'unresolved'
  )
    invalid();
  return {
    key: string(data.key),
    requirementKeys: array(data.requirementKeys, string),
    text: string(data.text),
    disclosure,
    evidence: array(data.evidence, parseEvidenceShapeV2),
    handlingBasis: string(data.handlingBasis),
  };
}
