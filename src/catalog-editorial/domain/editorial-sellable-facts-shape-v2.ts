import {
  parseCareCaptureShapeV2,
  type CareReviewCaptureV2,
} from './editorial-care-capture-shape-v2';
import {
  parseDeclarationShapeV2,
  type DeclarationShapeV2,
} from './editorial-declaration-shape-v2';

export type SellableFactsShapeV2 = {
  variantId: string | null;
  presentation: string;
  declarations: DeclarationShapeV2[];
  careReview: CareReviewCaptureV2 | null;
};

function invalid(): never {
  throw new TypeError('Expected a sellable facts shape V2');
}

function declarations(input: unknown): DeclarationShapeV2[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype)
    invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input as object);
  const length = descriptors.length.value as number;
  if (Reflect.ownKeys(descriptors).length !== length + 1) invalid();
  const result: DeclarationShapeV2[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[index];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
      invalid();
    result.push(parseDeclarationShapeV2(descriptor.value));
  }
  return result;
}

/** Primitive pre-receipt row only, not sellable ownership or publish admission. */
export function parseSellableFactsShapeV2(
  input: unknown,
): SellableFactsShapeV2 {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = ['variantId', 'presentation', 'declarations', 'careReview'];
  if (Reflect.ownKeys(descriptors).length !== keys.length) invalid();
  const data: Record<string, unknown> = {};
  for (const key of keys) {
    if (!Object.hasOwn(descriptors, key)) invalid();
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !('value' in descriptor)) invalid();
    data[key] = descriptor.value;
  }
  const { variantId, presentation } = data;
  if (
    (variantId !== null && typeof variantId !== 'string') ||
    typeof presentation !== 'string'
  )
    invalid();
  return {
    variantId,
    presentation,
    declarations: declarations(data.declarations),
    careReview:
      data.careReview === null
        ? null
        : parseCareCaptureShapeV2(data.careReview),
  };
}
