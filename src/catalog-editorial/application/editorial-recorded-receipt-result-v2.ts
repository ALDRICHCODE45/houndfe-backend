import { decodeRecordedEditorialStateV2 } from './editorial-recorded-state-v2';
import type { StateV2 } from './editorial-state-v2';
import type {
  EditorialWriteOperationV2,
  ReceiptRequestV2,
} from './editorial-write-request-v2';

export type CareAttestation = {
  actorId: string;
  confirmedAt: string;
  tenantId: string;
  productId: string;
  cycle: number;
  draftRevision: number;
  publishedRevision: number;
  vocabularyRevision: string;
  documentDigest: string;
  subjects: { variantId: string | null; presentation: string }[];
};
export type ReceiptResultV2 = {
  receiptVersion: 2;
  status: 200 | 201;
  body: StateV2;
  headers: {
    'Editorial-Contract-Version': '2';
    'Editorial-Vocabulary-Revision': string;
  };
  careAttestation: CareAttestation | null;
};
function invalid(): never {
  throw new TypeError('Expected a recorded receipt result V2');
}
function data(input: unknown, key: PropertyKey): PropertyDescriptor {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor?.enumerable || !('value' in descriptor)) invalid();
  return descriptor;
}
function closed(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== null && prototype !== Object.prototype) invalid();
  const own = Reflect.ownKeys(input);
  if (own.length !== keys.length || keys.some((key) => !own.includes(key)))
    invalid();
  return Object.fromEntries(
    keys.map((key) => [key, data(input, key).value as unknown]),
  );
}
function text(input: unknown): string {
  if (typeof input !== 'string') invalid();
  return input;
}
function counter(input: unknown): number {
  if (
    typeof input !== 'number' ||
    !Number.isInteger(input) ||
    input < 1 ||
    input > 2147483647
  )
    invalid();
  return input;
}
function subjects(input: unknown): CareAttestation['subjects'] {
  if (!Array.isArray(input)) invalid();
  const length: unknown = Object.getOwnPropertyDescriptor(
    input,
    'length',
  )?.value;
  if (
    typeof length !== 'number' ||
    Reflect.ownKeys(input).length !== length + 1
  )
    invalid();
  return Array.from({ length }, (_, index) => {
    const row = closed(data(input, String(index)).value, [
      'variantId',
      'presentation',
    ]);
    return {
      variantId: row.variantId === null ? null : text(row.variantId),
      presentation: text(row.presentation),
    };
  });
}
function attestation(
  input: unknown,
  request: ReceiptRequestV2,
  body: StateV2,
): CareAttestation {
  const row = closed(input, [
    'actorId',
    'confirmedAt',
    'tenantId',
    'productId',
    'cycle',
    'draftRevision',
    'publishedRevision',
    'vocabularyRevision',
    'documentDigest',
    'subjects',
  ]);
  const confirmedAt = text(row.confirmedAt);
  const timestamp = Date.parse(confirmedAt);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== confirmedAt
  )
    invalid();
  const documentDigest = text(row.documentDigest);
  if (
    documentDigest.length !== 'ecd2-sha256-'.length + 64 ||
    !/^ecd2-sha256-[0-9a-f]{64}$/.test(documentDigest)
  )
    invalid();
  const cycle = counter(row.cycle);
  const draftRevision = counter(row.draftRevision);
  const publishedRevision = counter(row.publishedRevision);
  const vocabularyRevision = text(row.vocabularyRevision);
  // Only called for publish: operation-corresponding request is a precondition.
  const { expectedRevision } = request.body as { expectedRevision: number };
  if (
    vocabularyRevision !== body.vocabularyRevision ||
    cycle !== request.body.expectedCycle ||
    cycle !== body.state.cycle ||
    draftRevision !== expectedRevision ||
    !body.state.published ||
    publishedRevision !== body.state.published.revision
  )
    invalid();
  return {
    actorId: text(row.actorId),
    confirmedAt,
    tenantId: text(row.tenantId),
    productId: text(row.productId),
    cycle,
    draftRevision,
    publishedRevision,
    vocabularyRevision,
    documentDigest,
    subjects: subjects(row.subjects),
  };
}
/** Request is already admitted for this operation; result is internal, not an HTTP DTO. */
export function decodeRecordedReceiptResultV2(
  operation: EditorialWriteOperationV2,
  request: ReceiptRequestV2,
  input: unknown,
): ReceiptResultV2 {
  if (
    operation !== 'initialize' &&
    operation !== 'save' &&
    operation !== 'publish' &&
    operation !== 'discard' &&
    operation !== 'unpublish'
  )
    invalid();
  const root = closed(input, [
    'receiptVersion',
    'status',
    'body',
    'headers',
    'careAttestation',
  ]);
  const status = root.status;
  if (
    root.receiptVersion !== 2 ||
    status !== (operation === 'initialize' ? 201 : 200)
  )
    invalid();
  // No catch: the recorded-state decoder owns its deliberate rejection and errors.
  const body = decodeRecordedEditorialStateV2(root.body);
  const headers = closed(root.headers, [
    'Editorial-Contract-Version',
    'Editorial-Vocabulary-Revision',
  ]);
  if (
    headers['Editorial-Contract-Version'] !== '2' ||
    headers['Editorial-Vocabulary-Revision'] !== body.vocabularyRevision ||
    body.vocabularyRevision !== request.vocabularyRevision
  )
    invalid();
  let careAttestation: CareAttestation | null = null;
  if (operation === 'publish' && request.careConfirmation === 'review-v1')
    careAttestation = attestation(root.careAttestation, request, body);
  else if (root.careAttestation !== null) invalid();
  return {
    receiptVersion: 2,
    status: status as 200 | 201,
    body,
    headers: {
      'Editorial-Contract-Version': '2',
      'Editorial-Vocabulary-Revision': body.vocabularyRevision,
    },
    careAttestation,
  };
}
