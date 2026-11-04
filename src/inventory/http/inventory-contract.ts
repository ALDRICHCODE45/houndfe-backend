import { createHash } from 'node:crypto';
import {
  parseSupplierId,
  parseSupplierIdempotencyKey,
  SupplierContractError,
} from '../../procurement/suppliers/supplier-contract';
import type {
  StockAdjustmentReason,
  StockMovementGroupType,
  StockMovementType,
  StockRemovalCause,
} from '../domain/stock-journal.types';

export const ADJUSTMENT_REASONS = [
  'PHYSICAL_COUNT',
  'DAMAGE',
  'EXPIRED',
  'THEFT_LOSS',
  'DATA_ENTRY_CORRECTION',
  'OTHER',
] as const satisfies readonly StockAdjustmentReason[];

/** Largest |delta| accepted; keeps bucket quantities inside Postgres INT. */
export const MAX_ADJUSTMENT_DELTA = 1_000_000_000;
export const MAX_NOTE_LENGTH = 500;
export const MAX_POSTGRES_INT = 2_147_483_647;

export interface AdjustmentTarget {
  productId: string;
  variantId: string | null;
  lotId: string | null;
}
export interface AdjustmentInput {
  target: AdjustmentTarget;
  expectedVersion: number;
  delta: number;
  reason: StockAdjustmentReason;
  note: string | null;
}
export interface MovementsQuery {
  productId: string;
  variantId?: string;
  lotId?: string;
  cursor?: string;
  limit: number;
}

export interface StockSnapshot {
  product: {
    id: string;
    name: string;
    useStock: boolean;
    quantity: number;
    untracked: { quantity: number; version: number };
    /** null when the product does not track stock. */
    sellable: number | null;
  };
  lots: {
    id: string;
    lotNumber: string;
    expirationDate: string;
    quantity: number;
    expired: boolean;
    version: number;
  }[];
  variants: { id: string; label: string; quantity: number; version: number }[];
}
export interface MovementView {
  id: string;
  type: StockMovementType;
  bucket: 'PRODUCT_UNTRACKED' | 'VARIANT' | 'LOT';
  productId: string;
  variantId: string | null;
  lotId: string | null;
  labels: { product: string; variant: string | null; lot: string | null };
  delta: number;
  balanceAfter: number;
  productBalanceAfter: number;
  reason: StockAdjustmentReason | null;
  note: string | null;
  removalCause: StockRemovalCause | null;
  group: { type: StockMovementGroupType; id: string };
  actor: { displayName: string };
  createdAt: string;
}
export interface AdjustmentResult {
  movement: MovementView;
  stock: StockSnapshot;
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

const ERROR_STATUS = {
  MALFORMED: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  STOCK_VERSION_CONFLICT: 409,
  INSUFFICIENT_STOCK: 409,
  STOCK_NOT_TRACKED: 409,
  IDEMPOTENCY_KEY_CONFLICT: 409,
  IDEMPOTENCY_KEY_IN_FLIGHT: 409,
  INTERNAL_ERROR: 500,
} as const;
export type InventoryErrorCode = keyof typeof ERROR_STATUS;
export type InventoryErrorEnvelope = {
  [Code in InventoryErrorCode]: {
    statusCode: (typeof ERROR_STATUS)[Code];
    error: Code;
  };
}[InventoryErrorCode];

/** Value-free feature error: only the code crosses the HTTP boundary. */
export class InventoryContractError extends Error {
  constructor(readonly code: InventoryErrorCode) {
    super(code);
  }
}
export function inventoryErrorEnvelope(error: unknown): InventoryErrorEnvelope {
  const code =
    (error instanceof InventoryContractError ||
      error instanceof SupplierContractError) &&
    Object.hasOwn(ERROR_STATUS, error.code)
      ? (error.code as InventoryErrorCode)
      : 'INTERNAL_ERROR';
  return {
    statusCode: ERROR_STATUS[code],
    error: code,
  } as InventoryErrorEnvelope;
}

function malformed(): never {
  throw new InventoryContractError('MALFORMED');
}
function parse<T>(read: () => T): T {
  try {
    return read();
  } catch {
    malformed();
  }
}
function fields(
  value: unknown,
  keys: readonly string[],
  required = keys,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) malformed();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) malformed();
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key)) malformed();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) malformed();
    result[key] = descriptor.value;
  }
  if (required.some((key) => !Object.hasOwn(result, key))) malformed();
  return result;
}
function optionalId(data: Record<string, unknown>, key: string): string | null {
  if (!Object.hasOwn(data, key) || data[key] === null) return null;
  return parseSupplierId(data[key]);
}

export function parseInventoryId(value: unknown): string {
  return parse(() => parseSupplierId(value));
}
export function parseInventoryIdempotencyKey(rawHeaders: unknown): string {
  return parse(() => parseSupplierIdempotencyKey(rawHeaders));
}

export function parseAdjustmentBody(value: unknown): AdjustmentInput {
  return parse(() => {
    const data = fields(
      value,
      ['target', 'expectedVersion', 'delta', 'reason', 'note'],
      ['target', 'expectedVersion', 'delta', 'reason'],
    );
    const target = fields(
      data.target,
      ['productId', 'variantId', 'lotId'],
      ['productId'],
    );
    const parsedTarget: AdjustmentTarget = {
      productId: parseSupplierId(target.productId),
      variantId: optionalId(target, 'variantId'),
      lotId: optionalId(target, 'lotId'),
    };
    if (parsedTarget.variantId !== null && parsedTarget.lotId !== null)
      malformed();
    const { expectedVersion, delta } = data;
    if (
      typeof expectedVersion !== 'number' ||
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 0 ||
      expectedVersion > MAX_POSTGRES_INT
    )
      malformed();
    if (
      typeof delta !== 'number' ||
      !Number.isSafeInteger(delta) ||
      delta === 0 ||
      Math.abs(delta) > MAX_ADJUSTMENT_DELTA
    )
      malformed();
    const reason = data.reason;
    if (
      typeof reason !== 'string' ||
      !(ADJUSTMENT_REASONS as readonly string[]).includes(reason)
    )
      malformed();
    let note: string | null = null;
    if (data.note !== undefined && data.note !== null) {
      if (
        typeof data.note !== 'string' ||
        data.note.includes('\0') ||
        /[\uD800-\uDFFF]/u.test(data.note) ||
        [...data.note].length > MAX_NOTE_LENGTH + 1000
      )
        malformed();
      const trimmed = data.note.trim();
      if ([...trimmed].length > MAX_NOTE_LENGTH) malformed();
      note = trimmed === '' ? null : trimmed;
    }
    if (reason === 'OTHER' && note === null) malformed();
    return {
      target: parsedTarget,
      expectedVersion,
      delta,
      reason: reason as StockAdjustmentReason,
      note,
    };
  });
}

export function parseMovementsQuery(value: unknown): MovementsQuery {
  return parse(() => {
    const data = fields(
      value,
      ['productId', 'variantId', 'lotId', 'cursor', 'limit'],
      ['productId'],
    );
    const result: MovementsQuery = {
      productId: parseSupplierId(data.productId),
      limit: 25,
    };
    const variantId = optionalId(data, 'variantId');
    const lotId = optionalId(data, 'lotId');
    if (variantId !== null && lotId !== null) malformed();
    if (variantId !== null) result.variantId = variantId;
    if (lotId !== null) result.lotId = lotId;
    if (Object.hasOwn(data, 'limit')) {
      if (
        typeof data.limit !== 'string' ||
        !/^[1-9][0-9]{0,2}$/.test(data.limit) ||
        Number(data.limit) > 100
      )
        malformed();
      result.limit = Number(data.limit);
    }
    if (Object.hasOwn(data, 'cursor')) {
      if (typeof data.cursor !== 'string' || !data.cursor.length) malformed();
      result.cursor = data.cursor;
    }
    return result;
  });
}

/** SHA-256 of the normalized closed body in fixed schema order; includes CAS. */
export function hashAdjustmentBody(value: unknown): string {
  const body = parseAdjustmentBody(value);
  return createHash('sha256')
    .update(
      JSON.stringify([
        body.target.productId,
        body.target.variantId,
        body.target.lotId,
        body.expectedVersion,
        body.delta,
        body.reason,
        body.note,
      ]),
      'utf8',
    )
    .digest('hex');
}
