import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

function invalid(): never {
  throw new TypeError('Expected a finite, acyclic JSON data tree');
}

function quoted(value: string): string {
  // Unicode mode matches lone surrogates, not valid supplementary scalars.
  if (/[\uD800-\uDFFF]/u.test(value)) invalid();
  // eslint-disable-next-line no-control-regex -- wire requires explicit C0 escaping
  const escaped = value.replace(/["\\\u0000-\u001f]/g, (character) => {
    if (character === '"') return '\\"';
    if (character === '\\') return '\\\\';
    return '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0');
  });
  return '"' + escaped + '"';
}

function encodeProperty(
  value: Record<string, unknown> | unknown[],
  key: string,
  ancestors: Set<object>,
): string {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
    invalid();
  }
  const data: unknown = descriptor.value;
  return encode(data, ancestors);
}

function encode(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return quoted(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid();
    return JSON.stringify(value); // ECMAScript spelling, including -0 as 0.
  }
  if (typeof value !== 'object' || ancestors.has(value)) invalid();
  ancestors.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (Array.isArray(value)) {
      if (
        Object.getPrototypeOf(value) !== Array.prototype ||
        keys.length !== value.length + 1
      ) {
        invalid();
      }
      const entries = Array.from({ length: value.length }, (_, index) =>
        encodeProperty(value, String(index), ancestors),
      );
      return '[' + entries.join(',') + ']';
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) invalid();
    const names = keys.map((key) => {
      if (typeof key !== 'string') invalid();
      return key;
    });
    names.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    return (
      '{' +
      names
        .map(
          (key) =>
            quoted(key) +
            ':' +
            encodeProperty(value as Record<string, unknown>, key, ancestors),
        )
        .join(',') +
      '}'
    );
  } finally {
    ancestors.delete(value);
  }
}

/** Generic canonical UTF-8 bytes; preserves arrays, does not validate a DTO. */
export function canonicalEditorialJson(value: unknown): Buffer {
  return Buffer.from(encode(value, new Set()), 'utf8');
}

/** Lowercase SHA-256 only: callers own validated preimages and domain prefixes. */
export function hashEditorialJson(value: unknown): string {
  return createHash('sha256')
    .update(canonicalEditorialJson(value))
    .digest('hex');
}
