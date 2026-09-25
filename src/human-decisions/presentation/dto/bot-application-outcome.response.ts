/**
 * DTO: BotApplicationOutcomeResponse — HD-05c1 bot terminal ACK response.
 *
 * Approved design (read-only):
 * `houndfe-chatbot-human-decisions/docs/human-decisions-contract-v1.md`
 * ("Bot outcome is separate ... exact replay of the same attempt ID/hash
 * returns the same result ... UNKNOWN and LATE enter a per-request
 * `NEEDS_RECONCILIATION` hold"). This pure mapper is DB-FREE; HD-05b owns the
 * Prisma adapter and HD-05c the guarded HTTP route that derives the tenant from
 * the service-credential guard.
 *
 * The bot `POST /chatbot-api/human-decisions/:id/application-outcome` success
 * body (HTTP 200 on first commit AND on any exact replay) is EXACTLY five
 * top-level keys: `{id,version,attemptId,outcome,ackReceivedAt}`. There is NO
 * sixth key: the `NEEDS_RECONCILIATION` hold derived from UNKNOWN/LATE is
 * signalled by the `outcome` discriminant ALONE, never by an extra flag. The
 * `version` is the pinned decision version `2`; a terminal ACK never changes
 * the decision version, and the HD-05b port enforces it, so a `PENDING`
 * decision (version 1) can never produce this acknowledgment — the mapper still
 * re-validates the discriminant at runtime.
 *
 * `ackReceivedAt` is the BACKEND RECEIPT clock (`Date`, converted to canonical
 * UTC ISO), NOT the bot-observed provider timestamp and NOT proof of device
 * delivery. It is distinct from the bot-reported `providerAcceptedObservedAt`
 * that participates only in the request evidence hash.
 *
 * FAIL CLOSED: a persisted acknowledgment is never trusted blindly, so this
 * pure projection re-validates every field before projecting it: `id` and
 * `attemptId` must be canonical RFC 4122 UUIDs (lowercase, variant 8/9/a/b, the
 * nil UUID rejected), `version` must be exactly `2`, `outcome` must be one of
 * the four accepted discriminants and `ackReceivedAt` must be a valid `Date`. A
 * malformed persisted acknowledgment throws a VALUE-FREE `Error`; the rejected
 * value is never echoed and never silently normalized.
 *
 * HOSTILE ACCESS HARDENING: the whole read/validate/project path runs inside
 * ONE narrow `try`/`catch`, so an allowed-key getter that throws, a revoked or
 * throwing Proxy `get` trap, or any other out-of-contract value ALWAYS surfaces
 * the same own constant `Error`. The catch never logs and never re-wraps the
 * trap message, so an attacker-supplied `Error` string can never reach the bot.
 * `ackReceivedAt` is read through the built-in
 * `Date.prototype.getTime.call(value)` / `Date.prototype.toISOString.call(value)`
 * rather than virtual dispatch, so a `Date` subclass or Proxy Date can never
 * redirect the read to a hostile `getTime`/`toISOString` override. A genuine
 * trusted Prisma `Date` is unaffected.
 *
 * EXPLICIT ALLOWLIST: the body is built key-by-key from the five allowlisted
 * fields with NO object spread from the persisted acknowledgment. Reviewer
 * identity, authority, tenant/credential columns, provider message IDs, the
 * canonical evidence hash and customer PII are never read and can never widen
 * this projection, even if a caller injects them onto the input object.
 */
import {
  DELIVERY_UNKNOWN,
  PROVIDER_ACCEPTED,
  PROVIDER_ACCEPTED_LATE,
  STALE,
  type BotApplicationOutcome,
} from '../../domain/bot-application-outcome.request';
import type { BotApplicationOutcomeAcknowledgment } from '../../domain/bot-application-outcome.repository';

/** Exact bot-safe terminal ACK body: five top-level keys. */
export interface BotApplicationOutcomeResponse {
  id: string;
  version: 2;
  attemptId: string;
  outcome: BotApplicationOutcome;
  /** Backend receipt clock as a canonical UTC ISO string. */
  ackReceivedAt: string;
}

/** Canonical RFC 4122 UUID (v1-v8, variant 8/9/a/b); the nil UUID is rejected. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Value-free fail-closed guard: never echoes a persisted value. */
function failClosed(): never {
  throw new Error('Malformed persisted bot application outcome acknowledgment');
}

/** Canonical lowercase RFC 4122 UUID; nil/invalid/uppercase all rejected. */
function assertValidUuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    failClosed();
  }
}

/** One of the four accepted discriminants; the reconciliation hold is implied. */
function assertValidOutcome(
  value: unknown,
): asserts value is BotApplicationOutcome {
  if (
    value !== PROVIDER_ACCEPTED &&
    value !== PROVIDER_ACCEPTED_LATE &&
    value !== DELIVERY_UNKNOWN &&
    value !== STALE
  ) {
    failClosed();
  }
}

/**
 * Real `Date` whose internal time is a valid instant. The built-in prototype
 * accessors are invoked explicitly, so a `Date` subclass or Proxy Date can
 * never redirect the read to a hostile `getTime` override that throws or
 * returns a spoofed value. A `Date` Proxy lacks the date internal slot, so the
 * built-in call throws and the caller's `catch` fails closed.
 */
function readValidDate(value: unknown): Date {
  if (!(value instanceof Date)) {
    failClosed();
  }
  // `strictBindCallApply` is off, so `.call` is loosely typed; assign to
  // `unknown` and narrow manually while still bypassing virtual dispatch.
  const rawTime: unknown = Date.prototype.getTime.call(value);
  if (typeof rawTime !== 'number' || Number.isNaN(rawTime)) {
    failClosed();
  }
  return value;
}

/**
 * Pure projection from the committed `BotApplicationOutcomeAcknowledgment` to
 * the exact five-key bot ACK body. Validates every persisted field first, reads
 * ONLY the allowlisted keys (no spread, so injected forbidden fields are
 * ignored) and never mutates the input. Throws a value-free `Error` on a
 * malformed persisted acknowledgment, including any exception raised while
 * reading a hostile getter, Proxy trap or `Date` override.
 */
export function toBotApplicationOutcomeResponse(
  acknowledgment: BotApplicationOutcomeAcknowledgment,
): BotApplicationOutcomeResponse {
  try {
    if (typeof acknowledgment !== 'object' || acknowledgment === null) {
      failClosed();
    }

    const { id, attemptId, ackReceivedAt } = acknowledgment;
    // Read through `unknown` so an out-of-contract persisted value is still
    // validated at runtime instead of being trusted from the static type.
    const version: unknown = acknowledgment.version;
    const outcome: unknown = acknowledgment.outcome;

    assertValidUuid(id);
    if (version !== 2) {
      failClosed();
    }
    assertValidUuid(attemptId);
    assertValidOutcome(outcome);
    const ackReceivedAtDate = readValidDate(ackReceivedAt);
    const rawIso: unknown = Date.prototype.toISOString.call(ackReceivedAtDate);
    if (typeof rawIso !== 'string') {
      failClosed();
    }

    return {
      id,
      version: 2,
      attemptId,
      outcome,
      ackReceivedAt: rawIso,
    };
  } catch {
    // Never log and never re-wrap: the trap message must not reach the bot.
    failClosed();
  }
}
