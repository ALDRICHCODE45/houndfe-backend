/**
 * DOMAIN: the realtime stream (human-intervention unit 8; contract §5.3, §6.4,
 * §10.1 R6, §12.1, §12.2, §12.8). Pure: event vocabulary, how an audit event
 * becomes a stream event, SSE framing, cursor parsing, limits and the
 * backpressure policy. No database, no HTTP.
 */

/** The audit event types of `chatbot_request_events` (Prisma enum values). */
export type RequestAuditEventType =
  | 'CREATED'
  | 'MERGED'
  | 'CLAIMED'
  | 'RELEASED'
  | 'AUTO_RELEASED'
  | 'REASSIGNED'
  | 'RESOLVED'
  | 'REPLIED'
  | 'TEMPLATE_SENT'
  | 'FINISHED'
  | 'CANCELLED'
  | 'RESCHEDULED'
  | 'CUSTOMER_LINKED'
  | 'SLA_MILESTONE'
  | 'DELIVERY_OUTCOME';

/** Stream events that carry a request row (§12.8). */
export const REQUEST_STREAM_TYPES = [
  'request.created',
  'request.claimed',
  'request.released',
  'request.reassigned',
  'request.resolved',
  'request.cancelled',
  'request.overdue',
  'request.updated',
  // Unit 11 (§12.8): session transitions carry the row like request events.
  'session.starting',
  'session.active',
  'session.ending',
  'session.ended',
] as const;
export type RequestStreamType = (typeof REQUEST_STREAM_TYPES)[number];

export const NOTIFICATION_STREAM_TYPES = [
  'notification.created',
  'notification.read',
] as const;
export type NotificationStreamType = (typeof NOTIFICATION_STREAM_TYPES)[number];

/** Conversation mirror events (unit 9): the message row is built at delivery. */
export const CONVERSATION_STREAM_TYPES = [
  'conversation.message',
  'message.status',
] as const;
export type ConversationStreamType = (typeof CONVERSATION_STREAM_TYPES)[number];

export const isConversationStreamType = (
  type: string,
): type is ConversationStreamType =>
  (CONVERSATION_STREAM_TYPES as readonly string[]).includes(type);

export const isRequestStreamType = (type: string): type is RequestStreamType =>
  (REQUEST_STREAM_TYPES as readonly string[]).includes(type);
export const isNotificationStreamType = (
  type: string,
): type is NotificationStreamType =>
  (NOTIFICATION_STREAM_TYPES as readonly string[]).includes(type);

/**
 * The single source of truth for "which audit event is announced, as what".
 * The SQL trigger (migration 20261112000000, extended by 20261112050000) implements exactly this table
 * (`realtime-event-log.integration.spec.ts` compares them for every enum
 * value), so a new audit type must be decided in both places.
 *
 * `null` = not announced: templates, finish and delivery
 * outcomes do not change the inbox row (they belong to units 9 to 11); the
 * target of a merge keeps its row unchanged; backfilled events are skipped by
 * the trigger itself.
 */
export function REQUEST_EVENT_TO_REALTIME(
  type: RequestAuditEventType,
  data: { role?: unknown; milestone?: unknown } = {},
): RequestStreamType | null {
  switch (type) {
    case 'CREATED':
      return 'request.created';
    case 'CLAIMED':
      return 'request.claimed';
    case 'RELEASED':
    case 'AUTO_RELEASED':
      return 'request.released';
    case 'REASSIGNED':
      return 'request.reassigned';
    case 'RESOLVED':
      return 'request.resolved';
    // Unit 10: a clarification reply closes the request (§2.2), so the inbox
    // row changes exactly as it does for a resolve.
    case 'REPLIED':
      return 'request.resolved';
    case 'CANCELLED':
      return 'request.cancelled';
    // The source of a staff merge is closed (SUPERSEDED); the target's row is
    // unchanged, so only the source is announced.
    case 'MERGED':
      return data.role === 'SOURCE' ? 'request.cancelled' : null;
    case 'CUSTOMER_LINKED':
      return 'request.updated';
    // An SLA milestone moves `slaLevel`; the overdue one also sets `overdueAt`.
    case 'SLA_MILESTONE':
      return data.milestone === 'OVERDUE'
        ? 'request.overdue'
        : 'request.updated';
    // Unit 14: a reschedule moves `scheduledFor` and clears `needsReschedule`.
    case 'RESCHEDULED':
      return 'request.updated';
    case 'TEMPLATE_SENT':
    case 'FINISHED':
    case 'DELIVERY_OUTCOME':
      return null;
  }
}

// ----------------------------------------------------------------- limits

export const STREAM_LIMITS = {
  /** §5.3, §12.1: a heartbeat every 15 s; the client gives up after 45 s. */
  heartbeatMs: 15_000,
  /** §5.3: the user, the membership and the permission are re-checked. */
  revalidateEveryMs: 5 * 60_000,
  /**
   * An access check is shared by every delivery of one user within this window
   * (a burst of events costs one check per user, not one per event).
   */
  accessCacheMs: 1_000,
  /** §6.4: at most 5 streams per user and tenant; the oldest is replaced. */
  maxStreamsPerUser: 5,
  /** Protection of one replica (the perf target is 200). */
  maxStreamsPerReplica: 1_000,
  /** Events replayed per page, and pages before the client must resync. */
  replayPageSize: 200,
  replayMaxPages: 5,
  /** Events the hub reads per wake-up and tenant. */
  hubBatchSize: 500,
  /** Backpressure (see `evaluateBackpressure`). */
  maxBufferedBytes: 512 * 1024,
  maxBlockedMs: 10_000,
  maxPendingEvents: 1_000,
  /** The retry hint sent to the browser. */
  retryMs: 3_000,
  /** Fallback lifetime when the token carries no `exp`. */
  defaultTokenLifetimeMs: 15 * 60_000,
} as const;

/** Retention of the log (§5.3). */
export const REALTIME_RETENTION_HOURS = 24;

// ----------------------------------------------------------- control events

export type ControlEventName =
  | 'ready'
  | 'heartbeat'
  | 'resync'
  | 'auth-expired'
  | 'access-revoked'
  | 'connection-replaced'
  | 'slow-consumer'
  | 'server-shutdown'
  | 'server-unavailable';

/** `server-shutdown` reasons: the client reconnects with `Last-Event-ID`. */
export type ShutdownReason = 'SHUTDOWN' | 'ERROR' | 'RESYNC_FAILED';

export type ResyncReason =
  | 'CURSOR_EXPIRED'
  | 'REPLAY_TOO_LARGE'
  | 'DELIVERY_FAILED';
export type RevokedReason =
  | 'USER_INACTIVE'
  | 'MEMBERSHIP_REMOVED'
  | 'PERMISSION_REVOKED';
export type SlowReason = 'BUFFER_FULL' | 'WRITE_BLOCKED' | 'BACKLOG';

// ------------------------------------------------------------------- framing

export interface SseFrame {
  /** Moves `Last-Event-ID`; omitted for heartbeats and closing events. */
  id?: bigint;
  event: string;
  data: unknown;
}

/** One SSE message. JSON never contains a raw newline, so one `data:` line. */
export function formatSseFrame(frame: SseFrame): string {
  const id = frame.id !== undefined ? `id: ${frame.id.toString()}\n` : '';
  return `${id}event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}

/** First message and reconnect hint: `retry:` is read by `EventSource`. */
export const retryPreamble = (ms: number): string => `retry: ${ms}\n\n`;

/**
 * `Last-Event-ID` (or `?after=`): digits only, at most 18 of them. Absent is
 * `null` (live only); anything else malformed is `undefined` (a 400).
 */
export function parseEventCursor(
  header: unknown,
  query: unknown,
): bigint | null | undefined {
  const raw = header !== undefined && header !== '' ? header : query;
  if (raw === undefined || raw === '') return null;
  if (typeof raw !== 'string' || !/^\d{1,18}$/.test(raw)) return undefined;
  return BigInt(raw);
}

// -------------------------------------------------------------- backpressure

export interface BackpressureState {
  /** Bytes accepted by `res.write` but not yet flushed to the socket. */
  bufferedBytes: number;
  /** Events waiting for the shaping pipeline of this stream. */
  pendingEvents: number;
  /** Milliseconds since `write` last returned `false` without a `drain`. */
  blockedForMs: number;
}

/**
 * A client that cannot keep up must not hold memory on the server: it is
 * dropped with a reason and reconnects with its `Last-Event-ID`, which replays
 * everything it missed from the durable log.
 */
export function evaluateBackpressure(
  state: BackpressureState,
  limits: Pick<
    typeof STREAM_LIMITS,
    'maxBufferedBytes' | 'maxBlockedMs' | 'maxPendingEvents'
  > = STREAM_LIMITS,
): SlowReason | null {
  if (state.bufferedBytes > limits.maxBufferedBytes) return 'BUFFER_FULL';
  if (state.blockedForMs > limits.maxBlockedMs) return 'WRITE_BLOCKED';
  if (state.pendingEvents > limits.maxPendingEvents) return 'BACKLOG';
  return null;
}

/** The expiry (`exp`, seconds) of a JWT the guards already verified. */
export function tokenExpiryMs(authorization: unknown): number | null {
  if (typeof authorization !== 'string') return null;
  const [scheme, token] = authorization.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(
      Buffer.from(part, 'base64url').toString('utf8'),
    ) as { exp?: unknown };
    return typeof claims.exp === 'number' && Number.isFinite(claims.exp)
      ? claims.exp * 1000
      : null;
  } catch {
    return null;
  }
}
