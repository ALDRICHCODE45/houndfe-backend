/**
 * Staff request shapes of the restock backorder contract (v1 §9.1, §9.3), parsed
 * from `unknown`: the staff controller keeps `@Query()`/`@Body()` typed
 * `unknown` (the global validation pipe skips metatype `Object`), so validation
 * is owned here and every failure is the same code-only
 * `400 INVALID_BACKORDER_REQUEST`, like the bot routes.
 *
 * An EMPTY query value (`?status=&q=`) is treated as absent, so a form that
 * sends every field blank asks for the plain list.
 */
import { BackorderError } from './backorder-error';
import {
  BACKORDER_STATUSES,
  isBackorderStatus,
  type BackorderStatusValue,
} from './backorder-status';

export const STAFF_LIST_DEFAULT_LIMIT = 20;
export const STAFF_LIST_MAX_LIMIT = 100;
/** `q` is split on whitespace; every word must match (see the list query). */
export const STAFF_SEARCH_MAX_LENGTH = 100;
export const STAFF_CANCEL_REASON_MAX_LENGTH = 280;

export const STAFF_SORT_FIELDS = [
  'scheduledAt',
  'status',
  'reservedUntil',
] as const;
export type StaffSortBy = (typeof STAFF_SORT_FIELDS)[number];
export type StaffSortOrder = 'asc' | 'desc';

export interface StaffBackorderListFilter {
  /** 1-based. */
  page: number;
  limit: number;
  statuses?: BackorderStatusValue[];
  productId?: string;
  variantId?: string;
  customerId?: string;
  /** Trimmed free text: customer name/phone or product/variant name. */
  q?: string;
  /** Inclusive bounds on `scheduledAt`. */
  from?: Date;
  to?: Date;
  sortBy: StaffSortBy;
  sortOrder: StaffSortOrder;
}

export type BackorderStatusCounts = Record<BackorderStatusValue, number>;

const invalid = () => new BackorderError('INVALID_BACKORDER_REQUEST');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const POSITIVE_INTEGER = /^[0-9]{1,9}$/;

const LIST_QUERY_KEYS = new Set([
  'page',
  'limit',
  'status',
  'productId',
  'variantId',
  'customerId',
  'q',
  'from',
  'to',
  'sortBy',
  'sortOrder',
]);

const isSortBy = (value: string): value is StaffSortBy =>
  (STAFF_SORT_FIELDS as readonly string[]).includes(value);

function uuid(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!UUID_SHAPE.test(value)) throw invalid();
  return value;
}

function instant(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (!ISO_WITH_ZONE.test(value) || Number.isNaN(date.getTime())) {
    throw invalid();
  }
  return date;
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (!POSITIVE_INTEGER.test(value)) throw invalid();
  const parsed = Number(value);
  if (parsed < 1 || parsed > max) throw invalid();
  return parsed;
}

/** `GET /backorders` query (§9.1). Unknown keys, repeated keys and bad values are rejected. */
export function parseStaffListQuery(value: unknown): StaffBackorderListFilter {
  if (!isRecord(value)) throw invalid();
  const raw: Record<string, string | undefined> = {};
  for (const [key, member] of Object.entries(value)) {
    if (!LIST_QUERY_KEYS.has(key) || typeof member !== 'string') {
      throw invalid();
    }
    raw[key] = member === '' ? undefined : member;
  }

  let statuses: BackorderStatusValue[] | undefined;
  if (raw.status !== undefined) {
    statuses = [];
    for (const part of raw.status.split(',').map((item) => item.trim())) {
      if (!isBackorderStatus(part)) throw invalid();
      if (!statuses.includes(part)) statuses.push(part);
    }
  }

  const q = raw.q?.trim();
  if (q !== undefined && q.length > STAFF_SEARCH_MAX_LENGTH) throw invalid();

  const sortBy = raw.sortBy ?? 'scheduledAt';
  if (!isSortBy(sortBy)) throw invalid();
  const sortOrder = raw.sortOrder ?? 'asc';
  if (sortOrder !== 'asc' && sortOrder !== 'desc') throw invalid();

  const from = instant(raw.from);
  const to = instant(raw.to);
  if (from && to && from.getTime() > to.getTime()) throw invalid();

  const productId = uuid(raw.productId);
  const variantId = uuid(raw.variantId);
  const customerId = uuid(raw.customerId);

  return {
    page: positiveInteger(raw.page, 1, 1_000_000),
    limit: positiveInteger(
      raw.limit,
      STAFF_LIST_DEFAULT_LIMIT,
      STAFF_LIST_MAX_LIMIT,
    ),
    ...(statuses ? { statuses } : {}),
    ...(productId ? { productId } : {}),
    ...(variantId ? { variantId } : {}),
    ...(customerId ? { customerId } : {}),
    ...(q ? { q } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    sortBy,
    sortOrder,
  };
}

export interface StaffCancelRequest {
  reason: string | null;
  /** The `version` of the backorder the POS is looking at. */
  version: number;
}

/** `POST /backorders/:id/cancel` body (§9.3): `{ reason?: ≤280, version }`. */
export function parseStaffCancelBody(value: unknown): StaffCancelRequest {
  if (!isRecord(value)) throw invalid();
  for (const key of Object.keys(value)) {
    if (key !== 'reason' && key !== 'version') throw invalid();
  }
  const { reason, version } = value;
  if (
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 1 ||
    version > 2_147_483_647
  ) {
    throw invalid();
  }
  if (reason !== undefined && reason !== null) {
    if (
      typeof reason !== 'string' ||
      reason.length > STAFF_CANCEL_REASON_MAX_LENGTH
    ) {
      throw invalid();
    }
  }
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  return { reason: trimmed ? trimmed : null, version };
}

export const emptyStatusCounts = (): BackorderStatusCounts =>
  Object.fromEntries(
    BACKORDER_STATUSES.map((status) => [status, 0]),
  ) as BackorderStatusCounts;

/** Fills the `GROUP BY status` result; a status with no row counts 0. */
export function toStatusCounts(
  groups: ReadonlyArray<{ status: BackorderStatusValue; count: number }>,
): BackorderStatusCounts {
  const counts = emptyStatusCounts();
  for (const group of groups) counts[group.status] = group.count;
  return counts;
}
