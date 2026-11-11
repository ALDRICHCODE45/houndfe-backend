/**
 * DOMAIN: recovery of the bot after `410 CURSOR_EXPIRED` (human-intervention
 * unit 5, slice 5c; contract §3.3). Pure: the query of
 * `GET /chatbot-api/requests?status=open&updatedSince=&cursor=&limit=50` and
 * its page cursor. No database, no HTTP.
 *
 * The page cursor is opaque to the bot. It carries the keyset position
 * `(updatedAt, id)` and the feed cursor read when the first page was served, so
 * every page of one recovery answers the same `nextCursor` (the feed position
 * to resume from) and a request that changes during the walk still shows up in
 * the feed after that position.
 */
import { InvalidArgumentError } from '../../shared/domain/domain-error';

export const RECOVERY_LIMITS = {
  defaultLimit: 50,
  maxLimit: 50,
  /** Per request: the latest undelivered feed items sent along. */
  deliveriesPerRequest: 5,
  /**
   * `updatedAt` and `closedAt` are stamped by whichever replica writes (the ORM
   * clock) and the bot's `updatedSince` comes from its own clock or a previous
   * answer, so the closed branch reaches this far before `updatedSince`; the
   * bot dedupes by request id.
   */
  clockSkewMs: 5_000,
} as const;

export interface RecoveryPage {
  updatedAt: Date;
  id: string;
  feedCursor: bigint;
}

export interface RecoveryQuery {
  updatedSince: Date | null;
  page: RecoveryPage | null;
  limit: number;
}

const bad = (): never => {
  throw new InvalidArgumentError(
    'Invalid recovery request',
    'INVALID_RECOVERY_REQUEST',
  );
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Canonical UTC instant (`…sss Z`), the one format of the bot contract. */
function readInstant(value: unknown): Date {
  if (typeof value !== 'string' || !CANONICAL_UTC.test(value)) return bad();
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    return bad();
  }
  return date;
}

export function encodeRecoveryPage(page: RecoveryPage): string {
  return Buffer.from(
    JSON.stringify({
      u: page.updatedAt.toISOString(),
      i: page.id,
      f: page.feedCursor.toString(),
    }),
    'utf8',
  ).toString('base64url');
}

function decodeRecoveryPage(token: unknown): RecoveryPage {
  if (
    typeof token !== 'string' ||
    token.length > 300 ||
    !BASE64URL.test(token)
  ) {
    return bad();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    return bad();
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return bad();
  }
  const { u, i, f, ...rest } = raw as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return bad();
  if (typeof i !== 'string' || !UUID.test(i)) return bad();
  if (typeof f !== 'string' || !/^\d{1,18}$/.test(f)) return bad();
  return { updatedAt: readInstant(u), id: i, feedCursor: BigInt(f) };
}

function readLimit(raw: unknown): number {
  if (raw === undefined) return RECOVERY_LIMITS.defaultLimit;
  if (typeof raw !== 'string' || !/^\d{1,3}$/.test(raw)) return bad();
  const limit = Number(raw);
  return limit < 1 || limit > RECOVERY_LIMITS.maxLimit ? bad() : limit;
}

/**
 * `status` is required and can only be `open` (the one recovery set: open
 * requests, plus those closed at or after `updatedSince`). Out-of-range values
 * and unknown keys are a 400, never clamped or ignored.
 */
export function parseRecoveryQuery(
  query: Record<string, unknown>,
): RecoveryQuery {
  const allowed = ['status', 'updatedSince', 'cursor', 'limit'];
  if (Object.keys(query).some((key) => !allowed.includes(key))) return bad();
  if (query.status !== 'open') return bad();
  return {
    updatedSince:
      query.updatedSince === undefined ? null : readInstant(query.updatedSince),
    page: query.cursor === undefined ? null : decodeRecoveryPage(query.cursor),
    limit: readLimit(query.limit),
  };
}
