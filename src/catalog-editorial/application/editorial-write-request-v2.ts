import {
  parseDocumentShapeV2,
  type DocumentShapeV2,
} from '../domain/editorial-document-shape-v2';

export type EditorialWriteOperationV2 =
  | 'initialize'
  | 'save'
  | 'publish'
  | 'discard';
type TransitionBody = { expectedCycle: number; expectedRevision: number };
export type ReceiptRequestV2 = {
  receiptVersion: 2;
  contractVersion: 2;
  vocabularyRevision: string;
  adoption: 'legacy-to-v2' | null;
  careConfirmation: 'review-v1' | null;
  body:
    | { expectedCycle: number | null }
    | TransitionBody
    | (TransitionBody & { document: DocumentShapeV2 });
};

function invalid(): never {
  throw new TypeError('Expected an editorial write request V2');
}

function record(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).length !== keys.length) invalid();
  const data: Record<string, unknown> = {};
  for (const key of keys) {
    if (!Object.hasOwn(descriptors, key)) invalid();
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !('value' in descriptor)) invalid();
    data[key] = descriptor.value;
  }
  return data;
}

function positiveInteger(input: unknown): input is number {
  return typeof input === 'number' && Number.isInteger(input) && input > 0;
}

/** Pre-receipt wire shape only; conditional state gates belong after receipt/CAS. */
export function createEditorialWriteRequestV2(
  operation: EditorialWriteOperationV2,
  headers: unknown,
  body: unknown,
): ReceiptRequestV2 {
  if (
    operation !== 'initialize' &&
    operation !== 'save' &&
    operation !== 'publish' &&
    operation !== 'discard'
  )
    invalid();
  const { vocabularyRevision, adoption, careConfirmation } = record(headers, [
    'vocabularyRevision',
    'adoption',
    'careConfirmation',
  ]);
  if (
    typeof vocabularyRevision !== 'string' ||
    vocabularyRevision.length !== 'ev2-sha256-'.length + 64 ||
    !/^ev2-sha256-[0-9a-f]{64}$/.test(vocabularyRevision) ||
    (adoption !== null && adoption !== 'legacy-to-v2') ||
    (careConfirmation !== null && careConfirmation !== 'review-v1') ||
    (adoption !== null && operation !== 'save') ||
    (careConfirmation !== null && operation !== 'publish')
  )
    invalid();
  const keys = ['expectedCycle'];
  if (operation !== 'initialize') keys.push('expectedRevision');
  if (operation === 'save') keys.push('document');
  const data = record(body, keys);
  const { expectedCycle, expectedRevision } = data;
  let detachedBody: ReceiptRequestV2['body'];
  if (operation === 'initialize') {
    if (expectedCycle !== null && !positiveInteger(expectedCycle)) invalid();
    detachedBody = { expectedCycle };
  } else {
    if (!positiveInteger(expectedCycle) || !positiveInteger(expectedRevision))
      invalid();
    detachedBody =
      operation === 'save'
        ? {
            expectedCycle,
            expectedRevision,
            document: parseDocumentShapeV2(data.document),
          }
        : { expectedCycle, expectedRevision };
  }
  return {
    receiptVersion: 2,
    contractVersion: 2,
    vocabularyRevision,
    adoption,
    careConfirmation,
    body: detachedBody,
  };
}
