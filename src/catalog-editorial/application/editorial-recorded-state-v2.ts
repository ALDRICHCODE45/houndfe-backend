import type { ArchivedOptionWarning } from '../domain/contextual-document';
import type { EditorialDocumentJson } from '../domain/editorial-document-json';
import { isRecognizableDocumentV2 } from '../domain/editorial-document-recognition-v2';
import type { DocumentShapeV2 } from '../domain/editorial-document-shape-v2';
import type { EditorialStateV2, StateV2 } from './editorial-state-v2';

function invalid(): never {
  throw new TypeError('Expected a recorded editorial state V2');
}
function record(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    invalid();
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== null && prototype !== Object.prototype) invalid();
  return input as Record<string, unknown>;
}
function dataDescriptor(input: unknown, key: PropertyKey): PropertyDescriptor {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor?.enumerable || !('value' in descriptor)) invalid();
  return descriptor;
}
function closed(
  input: unknown,
  keys: string[],
  optional: string[] = [],
): Record<string, unknown> {
  const row = record(input);
  const own = Reflect.ownKeys(row);
  if (keys.some((key) => !own.includes(key))) invalid();
  return Object.fromEntries(
    own.map((key) => {
      if (
        typeof key !== 'string' ||
        (!keys.includes(key) && !optional.includes(key))
      )
        invalid();
      return [key, dataDescriptor(row, key).value as unknown];
    }),
  );
}
function list(input: unknown): unknown[] {
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
  return Array.from(
    { length },
    (_, index) => dataDescriptor(input, String(index)).value as unknown,
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
function nullableCounter(input: unknown): number | null {
  return input === null ? null : counter(input);
}
// Ancestors, not all visited objects: shared acyclic children are copied separately.
function copyJson(
  input: unknown,
  ancestors = new WeakSet<object>(),
): EditorialDocumentJson {
  if (input === null || typeof input === 'string' || typeof input === 'boolean')
    return input;
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  if (typeof input !== 'object' || input === null || ancestors.has(input))
    invalid();
  ancestors.add(input);
  const result = Array.isArray(input)
    ? list(input).map((child) => copyJson(child, ancestors))
    : Object.fromEntries(
        Reflect.ownKeys(record(input)).map((key) => {
          if (typeof key !== 'string') invalid();
          return [key, copyJson(dataDescriptor(input, key).value, ancestors)];
        }),
      );
  ancestors.delete(input);
  return result;
}
function document(input: unknown): DocumentShapeV2 {
  // Guard and detach before recognition, including cyclic current-looking input.
  const copy = copyJson(input);
  if (!isRecognizableDocumentV2(copy)) invalid();
  return copy;
}
function warning(input: unknown): ArchivedOptionWarning {
  const row = closed(input, [
    'code',
    'familyId',
    'definitionId',
    'owner',
    'variantId',
    'optionCode',
  ]);
  const { code, owner, variantId } = row;
  if (
    code !== 'ARCHIVED_OPTION' ||
    (owner !== 'product' && owner !== 'sellable')
  )
    invalid();
  return {
    code,
    familyId: text(row.familyId),
    definitionId: text(row.definitionId),
    owner,
    variantId: variantId === null ? null : text(variantId),
    optionCode: text(row.optionCode),
  };
}
/** Recorded shape only: no authority, current metadata, or replay-side-effect proof. */
export function decodeRecordedEditorialStateV2(input: unknown): StateV2 {
  const root = closed(input, [
    'contractVersion',
    'vocabularyRevision',
    'state',
  ]);
  const vocabularyRevision = text(root.vocabularyRevision);
  if (
    root.contractVersion !== 2 ||
    vocabularyRevision.length !== 'ev2-sha256-'.length + 64 ||
    !/^ev2-sha256-[0-9a-f]{64}$/.test(vocabularyRevision)
  )
    invalid();
  const row = closed(root.state, ['cycle', 'draft', 'published'], ['warnings']);
  let draft: EditorialStateV2['draft'] = null;
  if (row.draft !== null) {
    const slot = closed(row.draft, [
      'revision',
      'basePublishedRevision',
      'document',
    ]);
    draft = {
      revision: counter(slot.revision),
      basePublishedRevision: nullableCounter(slot.basePublishedRevision),
      document: document(slot.document),
    };
  }
  let published: EditorialStateV2['published'] = null;
  if (row.published !== null) {
    const slot = closed(row.published, ['revision', 'document']);
    published = {
      revision: counter(slot.revision),
      document: document(slot.document),
    };
  }
  const state: EditorialStateV2 = {
    cycle: nullableCounter(row.cycle),
    draft,
    published,
  };
  if (Object.hasOwn(row, 'warnings'))
    state.warnings = list(row.warnings).map(warning);
  return { contractVersion: 2, vocabularyRevision, state };
}
