import { parseValueShapeV2, type ValueV2 } from './editorial-value-shape-v2';
import {
  parseSellableFactsShapeV2,
  type SellableFactsShapeV2,
} from './editorial-sellable-facts-shape-v2';

export type DocumentShapeV2 = {
  schemaVersion: 2;
  commercialTitle: string | null;
  description: string | null;
  mediaRefs: string[];
  familyCode: string | null;
  values: ValueV2[];
  facts: SellableFactsShapeV2[];
};

function invalid(): never {
  throw new TypeError('Expected a document shape V2');
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

/** Closed pre-receipt shape only, not historical recognition or fresh admission. */
export function parseDocumentShapeV2(input: unknown): DocumentShapeV2 {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = [
    'schemaVersion',
    'commercialTitle',
    'description',
    'mediaRefs',
    'familyCode',
    'values',
    'facts',
  ];
  if (Reflect.ownKeys(descriptors).length !== keys.length) invalid();
  const data: Record<string, unknown> = {};
  for (const key of keys) {
    if (!Object.hasOwn(descriptors, key)) invalid();
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !('value' in descriptor)) invalid();
    data[key] = descriptor.value;
  }
  const { commercialTitle, description, familyCode } = data;
  if (
    data.schemaVersion !== 2 ||
    (commercialTitle !== null && typeof commercialTitle !== 'string') ||
    (description !== null && typeof description !== 'string') ||
    (familyCode !== null && typeof familyCode !== 'string')
  )
    invalid();
  return {
    schemaVersion: 2,
    commercialTitle,
    description,
    mediaRefs: array(data.mediaRefs, (item) => {
      if (typeof item !== 'string') invalid();
      return item;
    }),
    familyCode,
    values: array(data.values, parseValueShapeV2),
    facts: array(data.facts, parseSellableFactsShapeV2),
  };
}
