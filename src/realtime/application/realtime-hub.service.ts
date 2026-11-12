/**
 * The per-replica fan-out of the realtime stream (human-intervention unit 8;
 * contract §5.3, §6.4, §10.1 R5/R6/R7/R12).
 *
 * ONE dedicated `LISTEN` connection serves the whole replica (R7, the shared
 * `PgNotificationListener`): no stream holds a database connection while it
 * waits. A `NOTIFY` carries the tenant id only; the hub then reads that
 * tenant's new events from the durable log ONCE (`id > cursor`), builds what
 * the batch needs ONCE (`HubShaper.prepare`: the request rows, customers,
 * policy) and writes a frame per recipient from memory. Ordering is safe
 * because within a tenant log id order is commit order (see
 * `realtime-event-writes.ts`), so a cursor never skips an event.
 *
 * Connecting (`connect`): the stream is registered first, so live events that
 * arrive while it replays are buffered; the replay then reads the log after
 * `Last-Event-ID` and the buffer is flushed with every id already sent
 * skipped. A cursor older than the retention, or a gap larger than the replay
 * budget, answers `event: resync` instead (the client refetches its lists).
 *
 * Every delivery re-checks the recipient (active user, membership,
 * `read:ChatbotRequest`, R5) through the shared `AccessGate`; a revoked
 * recipient gets `access-revoked` and nothing else. A failed read or delivery
 * is retried with backoff and never advances the cursor, so nothing is lost
 * (redelivery is harmless: a stream never sends an id twice).
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { PermissionCheck } from '../../chatbot-requests/domain/resolve-permissions';
import { REALTIME_CHANNEL } from '../../shared/realtime/realtime-event-writes';
import {
  STREAM_LIMITS,
  type ResyncReason,
  type SseFrame,
} from '../domain/realtime-events';
import type { RealtimeEventRow } from '../infrastructure/prisma-realtime-event.store';
import { REALTIME_ACCESS, type AccessPort } from './realtime-access';
import { RealtimeStream, type StreamSink } from './realtime-stream';

/** What the hub needs from the LISTEN connection (the shared listener). */
export interface HubListener {
  start(): Promise<void>;
  subscribe(channel: string, handler: (payload: string) => void): () => void;
  onConnected(handler: () => void): () => void;
}

/** What the hub needs from the log (`PrismaRealtimeEventStore`). */
export interface HubStore {
  tenantHead(tenantId: string): Promise<bigint>;
  purgedThrough(tenantId: string): Promise<bigint>;
  readAfter(
    tenantId: string,
    userId: string | null,
    after: bigint,
    limit: number,
  ): Promise<RealtimeEventRow[]>;
}

/** Builds the payload of an event for one recipient (R12). */
export interface HubShaper {
  /** Loads, once per batch, what the frames of this batch need. */
  prepare(tenantId: string, events: RealtimeEventRow[]): Promise<unknown>;
  /** `null` = nothing to send this recipient for this event. */
  shape(
    prepared: unknown,
    event: RealtimeEventRow,
    reader: { userId: string; ability: PermissionCheck },
  ): SseFrame | null;
}

export type HubAccess = AccessPort & {
  prime(tenantId: string, userId: string, ability: PermissionCheck): void;
};

export const REALTIME_LISTENER = Symbol('REALTIME_LISTENER');
export const REALTIME_STORE = Symbol('REALTIME_STORE');
export const REALTIME_SHAPER = Symbol('REALTIME_SHAPER');
export const REALTIME_HUB_OPTIONS = Symbol('REALTIME_HUB_OPTIONS');

/** The stream limits as plain numbers (the constants are literal types). */
export type HubLimits = { -readonly [K in keyof typeof STREAM_LIMITS]: number };

export interface HubOptions {
  limits?: Partial<HubLimits>;
  /** Base of the retry backoff after a failed batch (default 1 s). */
  failureBackoffMs?: number;
}

export interface ConnectParams {
  tenantId: string;
  userId: string;
  /** The ability the guards built at connect time. */
  ability: PermissionCheck;
  sink: StreamSink;
  /** `Last-Event-ID` / `?after=`; `null` = live only, from now. */
  after: bigint | null;
  expiresAtMs: number;
}

export interface StreamHandle {
  /** The client went away: stop writing and free the slot. */
  dispose(): void;
}

interface TenantFeed {
  tenantId: string;
  /** Highest id this replica has dispatched for the tenant. */
  cursor: bigint;
  ready: Promise<void>;
  streams: Set<RealtimeStream>;
  running: boolean;
  rerun: boolean;
  failures: number;
  inflightLast: bigint | null;
  retryTimer: NodeJS.Timeout | null;
}

/** Consecutive failures of one batch before the hub skips it and resyncs. */
const MAX_BATCH_FAILURES = 5;

const maxId = (a: bigint, b: bigint) => (a > b ? a : b);

@Injectable()
export class RealtimeHub {
  private readonly logger = new Logger(RealtimeHub.name);
  private readonly limits: HubLimits;
  private readonly failureBackoffMs: number;
  private readonly feeds = new Map<string, TenantFeed>();
  /** Streams per `tenant:user`, oldest first. */
  private readonly byUser = new Map<string, RealtimeStream[]>();
  private total = 0;
  private closing = false;
  private subscribed: Promise<void> | null = null;
  private readonly unsubscribe: Array<() => void> = [];

  constructor(
    @Inject(REALTIME_LISTENER) private readonly listener: HubListener,
    @Inject(REALTIME_STORE) private readonly store: HubStore,
    @Inject(REALTIME_SHAPER) private readonly shaper: HubShaper,
    @Inject(REALTIME_ACCESS) private readonly access: HubAccess,
    @Optional()
    @Inject(REALTIME_HUB_OPTIONS)
    options: HubOptions = {},
  ) {
    this.limits = { ...STREAM_LIMITS, ...options.limits };
    this.failureBackoffMs = options.failureBackoffMs ?? 1_000;
  }

  /** Streams open on this replica (diagnostics and the perf spec). */
  get openStreams(): number {
    return this.total;
  }

  /** Room for one more stream on this replica (§6.4 protection). */
  canAccept(): boolean {
    return !this.closing && this.total < this.limits.maxStreamsPerReplica;
  }

  async connect(params: ConnectParams): Promise<StreamHandle | null> {
    if (!this.canAccept()) return null;
    await this.ensureSubscribed();
    const { tenantId, userId } = params;
    const stream = new RealtimeStream({
      tenantId,
      userId,
      sink: params.sink,
      ability: params.ability,
      expiresAtMs: params.expiresAtMs,
      revalidate: () => this.access.check(tenantId, userId),
      onClose: (closed) => this.remove(closed),
    });
    this.replaceOldest(tenantId, userId);
    const feed = this.feedOf(tenantId);
    feed.streams.add(stream);
    const key = this.userKey(tenantId, userId);
    this.byUser.set(key, [...(this.byUser.get(key) ?? []), stream]);
    this.total += 1;
    // The guards just verified this user; the first delivery reuses it.
    this.access.prime(tenantId, userId, params.ability);
    stream.start();
    try {
      await feed.ready;
      await this.replay(stream, feed, params.after);
    } catch (error) {
      this.logger.error(
        `stream replay failed (tenant ${tenantId}): ${this.reason(error)}`,
      );
      // The client reconnects with its Last-Event-ID; nothing was skipped.
      stream.close({ event: 'server-shutdown', data: { reason: 'ERROR' } });
    }
    return { dispose: () => stream.close() };
  }

  /** Shutdown: tell every stream, so clients reconnect to another replica. */
  onModuleDestroy(): Promise<void> {
    this.closing = true;
    for (const off of this.unsubscribe) off();
    for (const feed of [...this.feeds.values()]) {
      if (feed.retryTimer) clearTimeout(feed.retryTimer);
      for (const stream of [...feed.streams]) {
        stream.close({
          event: 'server-shutdown',
          data: { reason: 'SHUTDOWN' },
        });
      }
    }
    this.feeds.clear();
    return Promise.resolve();
  }

  // ------------------------------------------------------------ subscription

  private ensureSubscribed(): Promise<void> {
    this.subscribed ??= (async () => {
      this.unsubscribe.push(
        this.listener.subscribe(REALTIME_CHANNEL, (tenantId) =>
          this.wake(tenantId),
        ),
        // A NOTIFY sent while the connection was down is gone (R7): read from
        // each cursor instead of trusting it.
        this.listener.onConnected(() => {
          for (const tenantId of [...this.feeds.keys()]) this.wake(tenantId);
        }),
      );
      await this.listener.start();
    })();
    return this.subscribed;
  }

  private feedOf(tenantId: string): TenantFeed {
    let feed = this.feeds.get(tenantId);
    if (!feed) {
      const created: TenantFeed = {
        tenantId,
        cursor: 0n,
        ready: Promise.resolve(),
        streams: new Set(),
        running: false,
        rerun: false,
        failures: 0,
        inflightLast: null,
        retryTimer: null,
      };
      created.ready = this.store.tenantHead(tenantId).then((head) => {
        created.cursor = maxId(created.cursor, head);
      });
      // A rejected head read surfaces in `connect`; keep it from being unhandled.
      created.ready.catch(() => undefined);
      this.feeds.set(tenantId, created);
      feed = created;
    }
    return feed;
  }

  private remove(stream: RealtimeStream): void {
    const key = this.userKey(stream.tenantId, stream.userId);
    const list = (this.byUser.get(key) ?? []).filter((s) => s !== stream);
    if (list.length === 0) this.byUser.delete(key);
    else this.byUser.set(key, list);
    const feed = this.feeds.get(stream.tenantId);
    if (feed?.streams.delete(stream)) this.total -= 1;
    if (feed && feed.streams.size === 0) {
      if (feed.retryTimer) clearTimeout(feed.retryTimer);
      this.feeds.delete(stream.tenantId);
    }
  }

  /** §6.4: at most N streams per user and tenant; the oldest is replaced. */
  private replaceOldest(tenantId: string, userId: string): void {
    const existing = this.byUser.get(this.userKey(tenantId, userId)) ?? [];
    const excess = existing.length - this.limits.maxStreamsPerUser + 1;
    for (const old of existing.slice(0, Math.max(0, excess))) {
      old.close({ event: 'connection-replaced', data: {} });
    }
  }

  // ----------------------------------------------------------------- replay

  private async replay(
    stream: RealtimeStream,
    feed: TenantFeed,
    after: bigint | null,
  ): Promise<void> {
    const { tenantId, userId } = stream;
    let from: bigint;
    if (after === null) {
      from = feed.cursor;
      stream.lastSentId = from;
      stream.send({
        ...(from > 0n ? { id: from } : {}),
        event: 'ready',
        data: {
          serverTime: new Date().toISOString(),
          heartbeatSeconds: this.limits.heartbeatMs / 1000,
        },
      });
    } else {
      const purged = await this.store.purgedThrough(tenantId);
      if (after < purged) {
        await this.resync(stream, 'CURSOR_EXPIRED');
        return this.goLive(stream);
      }
      from = after;
      stream.lastSentId = after;
    }

    const budget = this.limits.replayPageSize * this.limits.replayMaxPages;
    const collected: RealtimeEventRow[] = [];
    let readFrom = from;
    while (collected.length <= budget) {
      const wanted = Math.min(
        this.limits.replayPageSize,
        budget + 1 - collected.length,
      );
      const page = await this.store.readAfter(
        tenantId,
        userId,
        readFrom,
        wanted,
      );
      collected.push(...page);
      if (page.length < wanted) break;
      readFrom = page[page.length - 1].id;
    }
    if (stream.closed) return;
    if (collected.length > budget) {
      await this.resync(stream, 'REPLAY_TOO_LARGE');
      return this.goLive(stream);
    }
    for (let i = 0; i < collected.length; i += this.limits.replayPageSize) {
      if (stream.closed) return;
      await this.deliver(
        stream,
        collected.slice(i, i + this.limits.replayPageSize),
      );
    }
    await this.goLive(stream);
  }

  /** `event: resync`: the client refetches; the stream continues from the head. */
  private async resync(
    stream: RealtimeStream,
    reason: ResyncReason,
  ): Promise<void> {
    const head = await this.store.tenantHead(stream.tenantId);
    stream.lastSentId = maxId(stream.lastSentId, head);
    stream.send({
      ...(head > 0n ? { id: head } : {}),
      event: 'resync',
      data: { reason },
    });
  }

  /** Flushes what arrived during the replay, then switches to live. */
  private async goLive(stream: RealtimeStream): Promise<void> {
    for (;;) {
      if (stream.closed) return;
      const queued = stream.buffer.splice(0);
      if (queued.length === 0) break;
      const access = await this.access.check(stream.tenantId, stream.userId);
      if (stream.closed) return;
      if (!access.ok) {
        stream.close({
          event: 'access-revoked',
          data: { reason: access.reason },
        });
        return;
      }
      stream.ability = access.ability;
      for (const { prepared, event } of queued) {
        if (!this.write(stream, prepared, event)) return;
      }
    }
    // No await since the emptiness check: nothing can slip in unseen.
    stream.state = 'live';
  }

  /** Replay chunk: prepare, check the recipient, write in order. */
  private async deliver(
    stream: RealtimeStream,
    events: RealtimeEventRow[],
  ): Promise<void> {
    const prepared = await this.shaper.prepare(stream.tenantId, events);
    const access = await this.access.check(stream.tenantId, stream.userId);
    if (stream.closed) return;
    if (!access.ok) {
      stream.close({
        event: 'access-revoked',
        data: { reason: access.reason },
      });
      return;
    }
    stream.ability = access.ability;
    for (const event of events) {
      if (!this.write(stream, prepared, event)) return;
    }
  }

  /** One event to one stream; `false` when the stream is gone. */
  private write(
    stream: RealtimeStream,
    prepared: unknown,
    event: RealtimeEventRow,
  ): boolean {
    if (event.id <= stream.lastSentId) return true;
    const frame = this.shaper.shape(prepared, event, {
      userId: stream.userId,
      ability: stream.ability,
    });
    if (frame && !stream.send(frame)) return false;
    // A skipped event (nothing to show this recipient) still moves the cursor.
    stream.lastSentId = maxId(stream.lastSentId, event.id);
    return true;
  }

  // ------------------------------------------------------------------- live

  private wake(tenantId: string): void {
    const feed = this.feeds.get(tenantId);
    if (!feed || this.closing) return;
    if (feed.running) {
      feed.rerun = true;
      return;
    }
    void this.run(feed);
  }

  private async run(feed: TenantFeed): Promise<void> {
    feed.running = true;
    try {
      await feed.ready;
      do {
        feed.rerun = false;
        await this.drain(feed);
      } while (feed.rerun && !this.closing);
      feed.failures = 0;
    } catch (error) {
      this.fail(feed, error);
    } finally {
      feed.running = false;
    }
  }

  private async drain(feed: TenantFeed): Promise<void> {
    for (;;) {
      const rows = await this.store.readAfter(
        feed.tenantId,
        null,
        feed.cursor,
        this.limits.hubBatchSize,
      );
      if (rows.length === 0) return;
      const last = rows[rows.length - 1].id;
      feed.inflightLast = last;
      await this.dispatch(feed, rows);
      feed.inflightLast = null;
      feed.cursor = last;
      if (rows.length < this.limits.hubBatchSize) return;
    }
  }

  private async dispatch(
    feed: TenantFeed,
    rows: RealtimeEventRow[],
  ): Promise<void> {
    const prepared = await this.shaper.prepare(feed.tenantId, rows);
    const streams = [...feed.streams].filter((s) => !s.closed);
    const relevant = (stream: RealtimeStream) =>
      rows.filter(
        (e) =>
          e.id > stream.lastSentId &&
          (e.userId === null || e.userId === stream.userId),
      );

    // One access check per user with something to receive (R5), shared by all
    // of that user's streams.
    const users = new Set<string>();
    for (const stream of streams) {
      if (stream.state === 'live' && relevant(stream).length > 0) {
        users.add(stream.userId);
      }
    }
    const results = new Map<string, Awaited<ReturnType<AccessPort['check']>>>();
    await Promise.all(
      [...users].map((userId) =>
        this.access
          .check(feed.tenantId, userId)
          .then((result) => results.set(userId, result)),
      ),
    );

    for (const stream of streams) {
      if (stream.closed) continue;
      const events = relevant(stream);
      if (events.length === 0) continue;
      if (stream.state === 'replaying') {
        for (const event of events) stream.buffer.push({ prepared, event });
        stream.checkBacklog();
        continue;
      }
      const access = results.get(stream.userId);
      if (!access) continue;
      if (!access.ok) {
        stream.close({
          event: 'access-revoked',
          data: { reason: access.reason },
        });
        continue;
      }
      stream.ability = access.ability;
      for (const event of events) {
        if (!this.write(stream, prepared, event)) break;
      }
    }
  }

  /**
   * A failed batch never advances the cursor and is retried with backoff.
   * After `MAX_BATCH_FAILURES` the batch is skipped and every stream of the
   * tenant resyncs, so one poison event cannot stall a tenant forever.
   */
  private fail(feed: TenantFeed, error: unknown): void {
    feed.failures += 1;
    this.logger.error(
      `realtime batch failed (tenant ${feed.tenantId}, attempt ${feed.failures}): ${this.reason(error)}`,
    );
    if (feed.failures >= MAX_BATCH_FAILURES && feed.inflightLast !== null) {
      feed.cursor = feed.inflightLast;
      feed.inflightLast = null;
      feed.failures = 0;
      for (const stream of feed.streams) {
        if (stream.closed) continue;
        void this.resync(stream, 'REPLAY_TOO_LARGE').catch(() => undefined);
      }
    }
    if (feed.retryTimer || this.closing) return;
    const timer = setTimeout(
      () => {
        feed.retryTimer = null;
        this.wake(feed.tenantId);
      },
      this.failureBackoffMs * Math.max(1, feed.failures),
    );
    timer.unref();
    feed.retryTimer = timer;
  }

  private userKey(tenantId: string, userId: string): string {
    return `${tenantId}:${userId}`;
  }

  /** Class name only: an error message can carry data. */
  private reason(error: unknown): string {
    return error instanceof Error ? error.constructor.name : 'unknown';
  }
}
