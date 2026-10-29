import { EditorialDocumentShapeError } from './editorial-document-shape-error';

export type EvidenceV2 = { sourceRef: string; verifiedOn: string };

function invalid(): never {
  throw new EditorialDocumentShapeError('Expected an evidence shape V2');
}

/** Primitive pre-receipt shape only; fresh capture bounds are separate. */
export function parseEvidenceShapeV2(input: unknown): EvidenceV2 {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== 2 ||
    !Object.hasOwn(descriptors, 'sourceRef') ||
    !Object.hasOwn(descriptors, 'verifiedOn')
  )
    invalid();
  // Read descriptors, never submitted getters. Reflection failures propagate.
  for (const key of keys) {
    if (typeof key !== 'string') invalid();
    const descriptor = descriptors[key];
    if (
      !descriptor.enumerable ||
      !('value' in descriptor) ||
      typeof descriptor.value !== 'string'
    )
      invalid();
  }
  const sourceRef = descriptors.sourceRef.value as string;
  const verifiedOn = descriptors.verifiedOn.value as string;
  return { sourceRef, verifiedOn };
}

/** Pure typed predicate for fresh captures after shape parsing, not history. */
export function isFreshEvidenceV2(evidence: EvidenceV2): boolean {
  const { sourceRef, verifiedOn } = evidence;
  if (sourceRef.trim().length === 0) return false;
  let count = 0;
  for (const character of sourceRef) {
    const code = character.codePointAt(0)!;
    if (
      ++count > 1000 ||
      code <= 0x1f ||
      code === 0x7f ||
      (code >= 0xd800 && code <= 0xdfff)
    )
      return false;
  }
  if (
    verifiedOn.length !== 10 ||
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(verifiedOn)
  )
    return false;
  const year = Number(verifiedOn.slice(0, 4));
  const month = Number(verifiedOn.slice(5, 7));
  const day = Number(verifiedOn.slice(8, 10));
  if (year === 0 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [
    31,
    leap ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= monthDays[month - 1];
}
