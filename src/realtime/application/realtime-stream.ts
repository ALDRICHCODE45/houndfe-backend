/**
 * One SSE connection (unit 8; contract §5.3, §6.4, §10.1 R5/R6, §12.1).
 *
 * Owns what is per connection and needs no database: framing, the 15 s
 * heartbeat, the JWT-expiry close, the 5-minute access re-check timer and the
 * backpressure policy. The hub decides WHAT to send; this class decides
 * whether the client can still be written to.
 *
 * A client that cannot keep up is dropped with a `slow-consumer` event and a
 * reason instead of buffering without bound: it reconnects with its
 * `Last-Event-ID` and the durable log replays what it missed.
 */
import { Logger } from '@nestjs/common';
import type { PermissionCheck } from '../../chatbot-requests/domain/resolve-permissions';
import {
  evaluateBackpressure,
  formatSseFrame,
  retryPreamble,
  STREAM_LIMITS,
  type SlowReason,
  type SseFrame,
} from '../domain/realtime-events';
import type { RealtimeEventRow } from '../infrastructure/prisma-realtime-event.store';
import type { AccessResult } from './realtime-access';

/** The slice of the HTTP response a stream writes to (a fake in unit specs). */
export interface StreamSink {
  /** `false` = the socket buffer is full (wait for `drain`). */
  write(chunk: string): boolean;
  end(chunk?: string): void;
  /** Hard close, for a client that never reads what is left. */
  destroy(): void;
  /** Bytes accepted by `write` that the socket has not flushed yet. */
  readonly bufferedBytes: number;
  onDrain(callback: () => void): void;
}

/** An event waiting while a (re)connect is still replaying. */
export interface BufferedDelivery {
  prepared: unknown;
  event: RealtimeEventRow;
}

export type StreamState = 'replaying' | 'live' | 'closed';

/** Time a closing socket gets to flush before it is destroyed. */
const CLOSE_GRACE_MS = 2_000;

export interface RealtimeStreamOptions {
  tenantId: string;
  userId: string;
  sink: StreamSink;
  ability: PermissionCheck;
  /** Expiry of the JWT the stream was opened with (epoch ms). */
  expiresAtMs: number;
  /** Re-reads the user, membership and permission (R5). */
  revalidate: () => Promise<AccessResult>;
  onClose: (stream: RealtimeStream) => void;
  now?: () => number;
}

export class RealtimeStream {
  private readonly logger = new Logger(RealtimeStream.name);
  private readonly now: () => number;
  private timers: NodeJS.Timeout[] = [];
  private blockedSince: number | null = null;
  private drainHooked = false;

  readonly tenantId: string;
  readonly userId: string;
  /** Buffer of the live events that arrive while the replay is running. */
  readonly buffer: BufferedDelivery[] = [];
  ability: PermissionCheck;
  state: StreamState = 'replaying';
  /** Id of the last event written: replays and live batches skip below it. */
  lastSentId = 0n;
  readonly openedAt: number;

  constructor(private readonly options: RealtimeStreamOptions) {
    this.tenantId = options.tenantId;
    this.userId = options.userId;
    this.ability = options.ability;
    this.now = options.now ?? Date.now;
    this.openedAt = this.now();
  }

  /** Not narrowed by control flow, unlike `state`: safe to re-check after an await. */
  get closed(): boolean {
    return this.state === 'closed';
  }

  /** Writes the retry hint and arms the heartbeat, expiry and re-check. */
  start(): void {
    this.options.sink.write(retryPreamble(STREAM_LIMITS.retryMs));
    this.timers.push(
      this.unref(
        setInterval(() => this.heartbeat(), STREAM_LIMITS.heartbeatMs),
      ),
      this.unref(
        setInterval(() => void this.recheck(), STREAM_LIMITS.revalidateEveryMs),
      ),
      this.unref(
        setTimeout(
          () => this.close({ event: 'auth-expired', data: {} }),
          Math.max(0, this.options.expiresAtMs - this.now()),
        ),
      ),
    );
  }

  /**
   * Writes one frame. Returns `false` when the stream is closed or this write
   * dropped it (slow client). An `id` moves `lastSentId`.
   */
  send(frame: SseFrame): boolean {
    if (this.state === 'closed') return false;
    const accepted = this.options.sink.write(formatSseFrame(frame));
    if (frame.id !== undefined && frame.id > this.lastSentId) {
      this.lastSentId = frame.id;
    }
    if (!accepted && this.blockedSince === null) {
      this.blockedSince = this.now();
      this.hookDrain();
    }
    return this.checkBackpressure() === null;
  }

  /** Re-evaluates the policy; closes the stream when the client is too slow. */
  checkBackpressure(): SlowReason | null {
    const reason = evaluateBackpressure({
      bufferedBytes: this.options.sink.bufferedBytes,
      pendingEvents: this.buffer.length,
      blockedForMs:
        this.blockedSince === null ? 0 : this.now() - this.blockedSince,
    });
    if (reason) this.close({ event: 'slow-consumer', data: { reason } });
    return reason;
  }

  /** Called by the hub after it queued events for a replaying stream. */
  checkBacklog(): void {
    this.checkBackpressure();
  }

  /** Ends the stream, once. The frame, if any, is the last thing the client reads. */
  close(frame?: SseFrame): void {
    if (this.closed) return;
    this.state = 'closed';
    for (const timer of this.timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.timers = [];
    this.buffer.length = 0;
    this.options.sink.end(frame ? formatSseFrame(frame) : undefined);
    if (this.options.sink.bufferedBytes > 0) {
      // A client that never reads must not keep the socket (and memory) alive.
      this.unref(setTimeout(() => this.options.sink.destroy(), CLOSE_GRACE_MS));
    }
    this.options.onClose(this);
  }

  private heartbeat(): void {
    if (this.closed) return;
    this.send({
      event: 'heartbeat',
      data: { serverTime: new Date(this.now()).toISOString() },
    });
  }

  /** The periodic re-check of user, membership and permission (R5). */
  private async recheck(): Promise<void> {
    if (this.closed) return;
    try {
      const access = await this.options.revalidate();
      if (this.closed) return;
      if (access.ok) this.ability = access.ability;
      else
        this.close({
          event: 'access-revoked',
          data: { reason: access.reason },
        });
    } catch {
      // A failed lookup is not a revocation: try again at the next period.
      this.logger.warn(
        `access re-check failed (tenant ${this.tenantId}); keeping the stream`,
      );
    }
  }

  private hookDrain(): void {
    if (this.drainHooked) return;
    this.drainHooked = true;
    this.options.sink.onDrain(() => {
      this.blockedSince = null;
      this.drainHooked = false;
    });
  }

  private unref<T extends NodeJS.Timeout>(timer: T): T {
    timer.unref();
    return timer;
  }
}
