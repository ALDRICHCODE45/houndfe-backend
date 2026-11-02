import { createHash } from 'node:crypto';
import { validateHeaderValue } from 'node:http';

export type SupplierStatus = 'ACTIVE' | 'ARCHIVED';
export interface SupplierInput {
  displayName: string;
  termsText: string | null;
  status: SupplierStatus;
}
export type SupplierPatch = Partial<SupplierInput>;
export interface SupplierUpdate {
  expectedVersion: number;
  changes: SupplierPatch;
}
export interface Supplier extends SupplierInput {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface SupplierPage {
  items: Supplier[];
  nextCursor: string | null;
}
export interface SupplierListQuery {
  status: SupplierStatus | 'ALL';
  search?: string;
  limit: number;
  cursor?: string;
}

const ERROR_STATUS = {
  MALFORMED: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  SUPPLIER_VERSION_CONFLICT: 409,
  IDEMPOTENCY_KEY_CONFLICT: 409,
  IDEMPOTENCY_KEY_IN_FLIGHT: 409,
  INTERNAL_ERROR: 500,
} as const;
export type SupplierErrorCode = keyof typeof ERROR_STATUS;
export type SupplierErrorEnvelope = {
  [Code in SupplierErrorCode]: {
    statusCode: (typeof ERROR_STATUS)[Code];
    error: Code;
  };
}[SupplierErrorCode];

/** Value-free errors only; HTTP status mapping is separate from transport wiring. */
export class SupplierContractError extends Error {
  constructor(readonly code: SupplierErrorCode) {
    super(code);
  }
}

export function supplierErrorEnvelope(error: unknown): SupplierErrorEnvelope {
  const code =
    error instanceof SupplierContractError &&
    Object.hasOwn(ERROR_STATUS, error.code)
      ? error.code
      : 'INTERNAL_ERROR';
  return {
    statusCode: ERROR_STATUS[code],
    error: code,
  } as SupplierErrorEnvelope;
}

function malformed(): never {
  throw new SupplierContractError('MALFORMED');
}

/** Replace hostile proxy errors too; no rejected values or causes escape. */
function parse<T>(read: () => T): T {
  try {
    return read();
  } catch {
    malformed();
  }
}

/** Local closed-record admission, never invokes an input getter. */
function fields(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) malformed();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) malformed();
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) malformed();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) malformed();
    result[key] = descriptor.value;
  }
  if (required.some((key) => !Object.hasOwn(result, key))) malformed();
  return result;
}

/** PostgreSQL UTF-8 text: no NUL or lone surrogate; no NFC or whitespace rewrite. */
function text(value: unknown, max: number): string {
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    /[\uD800-\uDFFF]/u.test(value) ||
    [...value].length > max
  )
    malformed();
  return value;
}

function status(value: unknown): SupplierStatus {
  if (value !== 'ACTIVE' && value !== 'ARCHIVED') malformed();
  return value;
}

const INPUT_KEYS = ['displayName', 'termsText', 'status'] as const;
function supplierFields(value: unknown, patch: boolean): SupplierPatch {
  const data = fields(value, INPUT_KEYS, patch ? [] : INPUT_KEYS);
  if (!Object.keys(data).length) malformed();
  const result: SupplierPatch = {};
  // Fixed field order also defines the canonical hash preimage.
  if (Object.hasOwn(data, 'displayName')) {
    result.displayName = text(data.displayName, 200);
    if (!result.displayName.trim()) malformed();
  }
  if (Object.hasOwn(data, 'termsText')) {
    result.termsText =
      data.termsText === null ? null : text(data.termsText, 4000);
  }
  if (Object.hasOwn(data, 'status')) result.status = status(data.status);
  return result;
}

/** Already-decoded JSON; duplicate JSON members are not observable here. */
export function parseSupplierInput(value: unknown): SupplierInput {
  return parse(() => supplierFields(value, false) as SupplierInput);
}

export function parseSupplierUpdate(value: unknown): SupplierUpdate {
  return parse(() => {
    const keys = ['expectedVersion', 'changes'];
    const data = fields(value, keys, keys);
    const version = data.expectedVersion;
    if (
      typeof version !== 'number' ||
      !Number.isSafeInteger(version) ||
      version < 1
    )
      malformed();
    return {
      expectedVersion: version,
      changes: supplierFields(data.changes, true),
    };
  });
}

/** Query parser receives scalars without framework coercion; arrays are rejected. */
export function parseSupplierListQuery(value: unknown): SupplierListQuery {
  return parse(() => {
    const data = fields(
      value,
      ['status', 'search', 'limit', 'cursor'],
      ['status'],
    );
    const result: SupplierListQuery = {
      status: data.status === 'ALL' ? 'ALL' : status(data.status),
      limit: 25,
    };
    if (Object.hasOwn(data, 'search')) {
      // Check Unicode/NUL before trimming; bound the effective search term.
      const search = text(data.search, Infinity).trim();
      text(search, 200);
      if (search) result.search = search;
    }
    if (Object.hasOwn(data, 'limit')) {
      if (
        typeof data.limit !== 'string' ||
        !/^[1-9][0-9]{0,2}$/.test(data.limit)
      )
        malformed();
      result.limit = Number(data.limit);
      if (result.limit > 100) malformed();
    }
    if (Object.hasOwn(data, 'cursor')) {
      if (typeof data.cursor !== 'string' || !data.cursor.length) malformed();
      result.cursor = data.cursor; // Binding/decoding belongs to the later tenant-aware reader.
    }
    return result;
  });
}

/** Same v1-v8 / RFC variant, trim/lowercase policy as human-decisions resolve. */
export function parseSupplierId(value: unknown): string {
  return parse(() => {
    if (typeof value !== 'string') malformed();
    const id = value.trim().toLowerCase();
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        id,
      )
    )
      malformed();
    return id;
  });
}

/** Exactly one raw header, not a possibly joined framework headers lookup. */
export function parseSupplierIdempotencyKey(rawHeaders: unknown): string {
  return parse(() => {
    if (!Array.isArray(rawHeaders) || rawHeaders.length % 2) malformed();
    let key: string | undefined;
    for (let index = 0; index < rawHeaders.length; index += 2) {
      const name: unknown = rawHeaders[index];
      const value: unknown = rawHeaders[index + 1];
      if (typeof name !== 'string' || typeof value !== 'string') malformed();
      if (name.toLowerCase() !== 'idempotency-key') continue;
      if (key !== undefined || value.length < 1 || value.length > 200)
        malformed();
      validateHeaderValue('Idempotency-Key', value);
      key = value;
    }
    if (key === undefined) malformed();
    return key;
  });
}

/** SHA-256 of UTF-8 JSON of the closed body in fixed schema order; includes CAS. */
export function hashSupplierBody(
  operation: 'create' | 'update',
  value: unknown,
): string {
  if (operation !== 'create' && operation !== 'update') malformed();
  const body =
    operation === 'create'
      ? parseSupplierInput(value)
      : parseSupplierUpdate(value);
  return createHash('sha256')
    .update(JSON.stringify(body), 'utf8')
    .digest('hex');
}
