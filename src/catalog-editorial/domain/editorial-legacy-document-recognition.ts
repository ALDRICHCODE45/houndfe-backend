import type { EditorialDocument } from './document';

type Data = Record<string, { value: unknown }>;

// Inspect descriptors before using any submitted values; never invoke getters.
function objectData(input: unknown): Data | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') return null;
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !('value' in descriptor)) return null;
  }
  return descriptors as Data;
}

function closed(data: Data, keys: string[]): boolean {
  return (
    Object.keys(data).length === keys.length &&
    keys.every((key) => Object.hasOwn(data, key))
  );
}

function arrayData(input: unknown): Data | null {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype)
    return null;
  const descriptors = Object.getOwnPropertyDescriptors(input as object);
  const length: unknown = descriptors.length.value;
  if (typeof length !== 'number') return null;
  if (Reflect.ownKeys(descriptors).length !== length + 1) return null;
  for (let i = 0; i < length; i++) {
    const descriptor = descriptors[String(i)];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
      return null;
  }
  return descriptors as Data;
}

function nullableString(input: unknown): input is string | null {
  return input === null || typeof input === 'string';
}

function uniqueStrings(input: unknown): boolean {
  const data = arrayData(input);
  if (!data) return false;
  const seen = new Set<string>();
  for (let i = 0; i < (data.length.value as number); i++) {
    const item = data[i].value;
    if (typeof item !== 'string' || seen.has(item)) return false;
    seen.add(item);
  }
  return true;
}

function legacyValue(input: unknown): Data | null {
  const data = objectData(input);
  if (!data) return null;
  const type = data.type?.value;
  const keys = ['code', 'owner', 'variantId', 'type', 'value'];
  if (type === 'number') keys.push('unit');
  if (!closed(data, keys)) return null;
  const { code, owner, variantId, value } = data;
  if (typeof code.value !== 'string' || !nullableString(variantId.value))
    return null;
  if (owner.value !== 'product' && owner.value !== 'sellable') return null;
  if (owner.value === 'product' && variantId.value !== null) return null;
  switch (type) {
    case 'text':
    case 'single':
      return typeof value.value === 'string' ? data : null;
    case 'boolean':
      return typeof value.value === 'boolean' ? data : null;
    case 'number':
      return typeof value.value === 'number' &&
        Number.isFinite(value.value) &&
        nullableString(data.unit.value)
        ? data
        : null;
    case 'multi':
      return uniqueStrings(value.value) ? data : null;
    default:
      return null;
  }
}

/** Historical adoptability only, not current validity or adoption authority. */
export function isRecognizableLegacyDocument(
  input: unknown,
): input is EditorialDocument {
  const data = objectData(input);
  if (
    !data ||
    !closed(data, [
      'commercialTitle',
      'description',
      'mediaRefs',
      'familyCode',
      'values',
    ])
  )
    return false;
  if (
    !nullableString(data.commercialTitle.value) ||
    !nullableString(data.description.value) ||
    !nullableString(data.familyCode.value) ||
    !uniqueStrings(data.mediaRefs.value)
  )
    return false;
  const values = arrayData(data.values.value);
  if (!values) return false;
  const length = values.length.value as number;
  if (data.familyCode.value === null && length !== 0) return false;
  const seen = new Map<string, Set<string | null>>();
  for (let i = 0; i < length; i++) {
    const value = legacyValue(values[i].value);
    if (!value) return false;
    const code = value.code.value as string;
    const variant = value.variantId.value as string | null;
    const variants = seen.get(code) ?? new Set<string | null>();
    if (variants.has(variant)) return false;
    variants.add(variant);
    seen.set(code, variants);
  }
  return true;
}
