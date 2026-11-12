/**
 * Maps the `class-validator` errors of the global ValidationPipe (shape
 * errors of a settings body) to the same `{path, code}` list the domain
 * produces for rule errors (S11). Pure: no values are read from the body
 * except to tell "missing" from "wrong type"; nothing the caller sent is ever
 * copied into the result.
 */
import type { ValidationError } from 'class-validator';
import { ALL_SUBTYPES } from '../domain/chatbot-attention-settings';
import type { FieldError } from '../domain/chatbot-settings-validation';

/** `a.b[0].c`: numeric property names are array indexes. */
const join = (parent: string, property: string): string =>
  /^\d+$/.test(property)
    ? `${parent}[${property}]`
    : parent === ''
      ? property
      : `${parent}.${property}`;

type Json =
  | string
  | number
  | boolean
  | null
  | undefined
  | Json[]
  | { [key: string]: Json };

/** What the body holds at `path` (`undefined` when absent). */
const valueAt = (body: object | undefined, path: string): Json => {
  let current = body as Json;
  for (const part of path.match(/[^.[\]]+/g) ?? []) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as { [key: string]: Json })[part];
  }
  return current;
};

/** The property is absent or `null` in the body (tells "missing" from "wrong type"). */
const isMissingAt = (body: object | undefined, path: string): boolean => {
  const value = valueAt(body, path);
  return value === undefined || value === null;
};

const lastSegment = (path: string): string =>
  path
    .split('.')
    .pop()
    ?.replace(/\[\d+\]$/, '') ?? path;

function codeOf(
  constraint: string,
  path: string,
  body: object | undefined,
): string {
  const missing = isMissingAt(body, path);
  switch (constraint) {
    case 'whitelistValidation':
      return 'UNKNOWN_FIELD';
    case 'isInt':
    case 'isString':
    case 'isBoolean':
    case 'isObject':
    case 'isArray':
    case 'isNumber':
      return missing ? 'REQUIRED' : 'INVALID_TYPE';
    case 'matches':
      if (missing) return 'REQUIRED';
      return ['open', 'close'].includes(lastSegment(path))
        ? 'INVALID_TIME'
        : 'INVALID_VALUE';
    case 'arrayMaxSize':
      if (lastSegment(path) === 'ranges') return 'TOO_MANY_RANGES';
      return lastSegment(path) === 'closedDates'
        ? 'TOO_MANY_DATES'
        : 'OUT_OF_RANGE';
    case 'min':
    case 'max':
      return missing ? 'REQUIRED' : 'OUT_OF_RANGE';
    case 'maxLength':
    case 'minLength':
      return 'INVALID_LENGTH';
    default:
      return 'INVALID_VALUE';
  }
}

/** Constraints declared with `each: true` in the settings DTOs. */
const EACH = new Set(['isString', 'isIn']);
const SUBTYPE_LIST: readonly Json[] = ALL_SUBTYPES;

function entryFails(constraint: string, path: string, item: Json): boolean {
  if (constraint === 'isString') return typeof item !== 'string';
  return path === 'enabledSubtypes' ? !SUBTYPE_LIST.includes(item) : false;
}

export function fieldErrorsOfValidation(
  errors: ValidationError[],
  body: object | undefined,
): FieldError[] {
  const out: FieldError[] = [];
  const walk = (error: ValidationError, parent: string) => {
    const path = join(parent, error.property);
    const first = Object.keys(error.constraints ?? {})[0];
    const value = valueAt(body, path);
    if (first && Array.isArray(value) && EACH.has(first)) {
      // `each: true` reports the whole array: locate the offending entries.
      value.forEach((item, index) => {
        if (!entryFails(first, path, item)) return;
        out.push({
          path: `${path}[${index}]`,
          code: first === 'isString' ? 'INVALID_TYPE' : 'INVALID_VALUE',
        });
      });
      if (!out.some((e) => e.path.startsWith(`${path}[`))) {
        out.push({ path, code: codeOf(first, path, body) });
      }
    } else if (first) out.push({ path, code: codeOf(first, path, body) });
    for (const child of error.children ?? []) walk(child, path);
  };
  for (const error of errors) walk(error, '');
  return out;
}

/** The class-validator list inside the pipe's `BadRequestException`, if any. */
export function validationErrorsOf(
  response: unknown,
): ValidationError[] | null {
  if (typeof response !== 'object' || response === null) return null;
  const { message } = response as { message?: unknown };
  if (!Array.isArray(message) || message.length === 0) return null;
  const looksLikeError = (m: unknown): m is ValidationError =>
    typeof m === 'object' && m !== null && 'property' in m;
  return message.every(looksLikeError) ? message : null;
}
