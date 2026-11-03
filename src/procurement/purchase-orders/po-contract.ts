import { createHash } from 'node:crypto';
import {
  parseSupplierId,
  parseSupplierIdempotencyKey,
  SupplierContractError,
} from '../suppliers/supplier-contract';

export const UNITS_OF_MEASURE = [
  'UNIDAD',
  'CAJA',
  'BOLSA',
  'METRO',
  'CENTIMETRO',
  'KILOGRAMO',
  'GRAMO',
  'LITRO',
  'HORA',
  'SESION',
  'DIA',
  'CONSULTA',
  'CURSO',
  'PAQUETE',
] as const;
export type UnitOfMeasure = (typeof UNITS_OF_MEASURE)[number];
export type TaxBasis = 'INCLUDES_TAX' | 'EXCLUDES_TAX';
export interface InformedUnitCost {
  amount: string | null;
  currency: 'MXN' | null;
  unit: UnitOfMeasure | null;
  taxBasis: TaxBasis | null;
}
export interface OrderLine {
  lineId: string;
  productId: string | null;
  variantId: string | null;
  orderedQuantity: string | null;
  informedUnitCost: InformedUnitCost | null;
}
export interface OrderInput {
  supplierId: string | null;
  note: string | null;
  location: { detail: string | null };
  lines: OrderLine[];
}
export interface PurchaseOrderReplace {
  expectedVersion: number;
  order: OrderInput;
}
export interface PurchaseOrderDelete {
  expectedVersion: number;
}
export interface PurchaseOrderListQuery {
  supplierId?: string;
  limit: number;
  cursor?: string;
}
export interface SupplierDisplaySnapshot {
  id: string;
  displayName: string;
  status: 'ACTIVE' | 'ARCHIVED';
}
export interface LineSubtotal {
  lineId: string;
  subtotal: { amount: string; currency: 'MXN'; taxBasis: TaxBasis } | null;
}
export type PurchaseOrderIssueCode =
  | 'SUPPLIER_REQUIRED'
  | 'SUPPLIER_ARCHIVED'
  | 'LINES_REQUIRED'
  | 'PRODUCT_REQUIRED'
  | 'VARIANT_REQUIRED'
  | 'REFERENCE_UNAVAILABLE'
  | 'REFERENCE_INCOMPATIBLE'
  | 'UNIT_MISMATCH'
  | 'QUANTITY_REQUIRED'
  | 'QUANTITY_FRACTION_NOT_ALLOWED'
  | 'COST_AMOUNT_REQUIRED'
  | 'COST_CURRENCY_REQUIRED'
  | 'COST_UNIT_REQUIRED'
  | 'COST_TAX_BASIS_REQUIRED';
export interface PurchaseOrderIssue {
  path: string;
  code: PurchaseOrderIssueCode;
}
export interface PurchaseOrder extends OrderInput {
  id: string;
  version: number;
  status: 'DRAFT';
  createdAt: string;
  updatedAt: string;
  supplierDisplaySnapshot: SupplierDisplaySnapshot | null;
  lineDisplaySnapshots: Array<{
    lineId: string;
    productName: string | null;
    variantName: string | null;
    unit: UnitOfMeasure | null;
  }>;
  lineSubtotals: LineSubtotal[];
  locationSnapshot: {
    tenantId: string;
    tenantName: string;
    detail: string | null;
  };
  validation: { issues: PurchaseOrderIssue[] };
}
export interface PurchaseOrderSummary {
  id: string;
  version: number;
  status: 'DRAFT';
  supplierDisplaySnapshot: SupplierDisplaySnapshot | null;
  lineCount: number;
  issueCount: number;
  note: string | null;
  locationDetail: string | null;
  createdAt: string;
  updatedAt: string;
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
  ORDER_VERSION_CONFLICT: 409,
  SUPPLIER_ARCHIVED: 409,
  IDEMPOTENCY_KEY_CONFLICT: 409,
  IDEMPOTENCY_KEY_IN_FLIGHT: 409,
  INTERNAL_ERROR: 500,
} as const;
export type PurchaseOrderErrorCode = keyof typeof ERROR_STATUS;
export type PurchaseOrderErrorEnvelope = {
  [Code in PurchaseOrderErrorCode]: {
    statusCode: (typeof ERROR_STATUS)[Code];
    error: Code;
  };
}[PurchaseOrderErrorCode];
/** Value-free feature error; reused supplier failures are translated at admission. */
export class PurchaseOrderContractError extends Error {
  constructor(readonly code: PurchaseOrderErrorCode) {
    super(code);
  }
}
export function purchaseOrderErrorEnvelope(
  error: unknown,
): PurchaseOrderErrorEnvelope {
  const code =
    (error instanceof PurchaseOrderContractError ||
      error instanceof SupplierContractError) &&
    Object.hasOwn(ERROR_STATUS, error.code)
      ? (error.code as PurchaseOrderErrorCode)
      : 'INTERNAL_ERROR';
  return {
    statusCode: ERROR_STATUS[code],
    error: code,
  } as PurchaseOrderErrorEnvelope;
}
function malformed(): never {
  throw new PurchaseOrderContractError('MALFORMED');
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
function nullable<T>(value: unknown, read: (value: unknown) => T): T | null {
  return value === null ? null : read(value);
}
function choice<T extends string>(value: unknown, options: readonly T[]): T {
  if (typeof value !== 'string' || !options.includes(value as T)) malformed();
  return value as T;
}
export const QUANTITY_PATTERN = /^(0|[1-9][0-9]{0,8})(\.[0-9]{1,3})?$/;
const AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,4})?$/;
function decimal(value: unknown, pattern: RegExp, positive: boolean): string {
  if (
    typeof value !== 'string' ||
    !pattern.test(value) ||
    (positive && !/[1-9]/.test(value))
  )
    malformed();
  return value;
}
function cost(value: unknown): InformedUnitCost {
  const data = fields(value, ['amount', 'currency', 'unit', 'taxBasis']);
  return {
    amount: nullable(data.amount, (value) =>
      decimal(value, AMOUNT_PATTERN, false),
    ),
    currency: nullable(data.currency, (value) => choice(value, ['MXN'])),
    unit: nullable(data.unit, (value) => choice(value, UNITS_OF_MEASURE)),
    taxBasis: nullable(data.taxBasis, (value) =>
      choice(value, ['INCLUDES_TAX', 'EXCLUDES_TAX']),
    ),
  };
}
function line(value: unknown): OrderLine {
  const data = fields(value, [
    'lineId',
    'productId',
    'variantId',
    'orderedQuantity',
    'informedUnitCost',
  ]);
  const productId = nullable(data.productId, parseSupplierId);
  const variantId = nullable(data.variantId, parseSupplierId);
  if (variantId !== null && productId === null) malformed();
  return {
    lineId: parseSupplierId(data.lineId),
    productId,
    variantId,
    orderedQuantity: nullable(data.orderedQuantity, (value) =>
      decimal(value, QUANTITY_PATTERN, true),
    ),
    informedUnitCost: nullable(data.informedUnitCost, cost),
  };
}
/** Decoded JSON only: transport must reject duplicate raw JSON members separately. */
export function parseOrderInput(value: unknown): OrderInput {
  return parse(() => {
    const data = fields(value, ['supplierId', 'note', 'location', 'lines']);
    const location = fields(data.location, ['detail']);
    if (!Array.isArray(data.lines) || data.lines.length > 200) malformed();
    // Inspect descriptors instead of invoking array getters; reject holes/extras.
    const array: unknown[] = data.lines;
    if (Reflect.ownKeys(array).length !== array.length + 1) malformed();
    const lines: OrderLine[] = [];
    const ids = new Set<string>();
    for (let index = 0; index < array.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
      if (!descriptor?.enumerable || !('value' in descriptor)) malformed();
      const item = line(descriptor.value);
      if (ids.has(item.lineId)) malformed();
      ids.add(item.lineId);
      lines.push(item);
    }
    return {
      supplierId: nullable(data.supplierId, parseSupplierId),
      note: nullable(data.note, (value) => text(value, 2000)),
      location: {
        detail: nullable(location.detail, (value) => text(value, 500)),
      },
      lines,
    };
  });
}
function version(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    malformed();
  return value;
}
export function parsePurchaseOrderReplace(
  value: unknown,
): PurchaseOrderReplace {
  return parse(() => {
    const data = fields(value, ['expectedVersion', 'order']);
    return {
      expectedVersion: version(data.expectedVersion),
      order: parseOrderInput(data.order),
    };
  });
}
export function parsePurchaseOrderDelete(value: unknown): PurchaseOrderDelete {
  return parse(() => {
    const data = fields(value, ['expectedVersion']);
    return { expectedVersion: version(data.expectedVersion) };
  });
}
export function parsePurchaseOrderId(value: unknown): string {
  return parse(() => parseSupplierId(value));
}
export function parsePurchaseOrderIdempotencyKey(rawHeaders: unknown): string {
  return parse(() => parseSupplierIdempotencyKey(rawHeaders));
}
export function parsePurchaseOrderListQuery(
  value: unknown,
): PurchaseOrderListQuery {
  return parse(() => {
    const data = fields(value, ['supplierId', 'limit', 'cursor'], []);
    const result: PurchaseOrderListQuery = { limit: 25 };
    if (Object.hasOwn(data, 'supplierId'))
      result.supplierId = parseSupplierId(data.supplierId);
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
/** Fixed schema-order UTF-8 JSON with CAS; operation/target namespace is receipt-owned. */
export function hashPurchaseOrderBody(
  operation: 'create' | 'replace' | 'delete',
  value: unknown,
): string {
  if (
    operation !== 'create' &&
    operation !== 'replace' &&
    operation !== 'delete'
  )
    malformed();
  const body =
    operation === 'create'
      ? parseOrderInput(value)
      : operation === 'replace'
        ? parsePurchaseOrderReplace(value)
        : parsePurchaseOrderDelete(value);
  return createHash('sha256')
    .update(JSON.stringify(body), 'utf8')
    .digest('hex');
}
