import { EditorialDocumentShapeError } from './editorial-document-shape-error';

export type KnownPayloadV2 =
  | { type: 'text'; value: string }
  | { type: 'single'; value: string }
  | { type: 'boolean'; value: boolean }
  | { type: 'number'; value: number; unit: string | null }
  | { type: 'multi'; value: string[] }
  | { type: 'range'; min: number; max: number; unit: string };

type Data = Record<string, { value: unknown }>;

function invalid(): never {
  throw new EditorialDocumentShapeError('Expected a known payload shape V2');
}

// Inspect all descriptors before reading submitted values; no getter execution.
function objectData(input: unknown): Data {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') invalid();
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !('value' in descriptor)) invalid();
  }
  return descriptors as Data;
}

function closed(data: Data, keys: string[]): void {
  if (
    Object.keys(data).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(data, key))
  )
    invalid();
}

function strings(input: unknown): string[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype)
    invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input as object);
  const length: unknown = descriptors.length.value;
  if (typeof length !== 'number') invalid();
  if (Reflect.ownKeys(descriptors).length !== length + 1) invalid();
  const result: string[] = [];
  for (let i = 0; i < length; i++) {
    const descriptor = descriptors[String(i)];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
      invalid();
    const value: unknown = descriptor.value;
    if (typeof value !== 'string') invalid();
    result.push(value);
  }
  return result;
}

function finite(input: unknown): input is number {
  return typeof input === 'number' && Number.isFinite(input);
}

/** Closed pre-receipt shape only; not historical recognition or fresh admission. */
export function parseKnownPayloadShapeV2(input: unknown): KnownPayloadV2 {
  const data = objectData(input);
  const type = data.type?.value;
  switch (type) {
    case 'text':
    case 'single': {
      closed(data, ['type', 'value']);
      const value = data.value.value;
      if (typeof value !== 'string') invalid();
      return { type, value };
    }
    case 'boolean': {
      closed(data, ['type', 'value']);
      const value = data.value.value;
      if (typeof value !== 'boolean') invalid();
      return { type, value };
    }
    case 'number': {
      closed(data, ['type', 'value', 'unit']);
      const value = data.value.value;
      const unit = data.unit.value;
      if (!finite(value) || (unit !== null && typeof unit !== 'string'))
        invalid();
      return { type, value, unit };
    }
    case 'multi':
      closed(data, ['type', 'value']);
      return { type, value: strings(data.value.value) };
    case 'range': {
      closed(data, ['type', 'min', 'max', 'unit']);
      const min = data.min.value;
      const max = data.max.value;
      const unit = data.unit.value;
      if (!finite(min) || !finite(max) || typeof unit !== 'string') invalid();
      return { type, min, max, unit };
    }
    default:
      return invalid();
  }
}
