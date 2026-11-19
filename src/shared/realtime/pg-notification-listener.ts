/**
 * R7 (contract §10.1): ONE dedicated PostgreSQL connection per replica for
 * `LISTEN`, outside the Prisma pool, so any number of waiting long-polls (and,
 * later, SSE streams) hold no pool connection while they wait.
 *
 * - The connection opens lazily on the first `start()`.
 * - It reconnects with exponential backoff and jitter. Every successful
 *   (re)connect runs the `onConnected` handlers: a `NOTIFY` sent while the
 *   connection was down is gone, so consumers re-read from the last id they saw
 *   instead of trusting the notification.
 * - A connection that dies silently (a half-open socket after a network
 *   partition or a proxy timeout raises no error) is caught two ways: TCP
 *   keepalive (first probe after 10 s) and an application heartbeat, a
 *   `SELECT 1` every 30 s that must answer within 10 s or the connection is
 *   treated as lost and replaced.
 * - Payloads are whatever `pg_notify` sent; the feed sends the tenant id only.
 *
 * LISTEN needs a session connection: with a transaction-pooling proxy in front
 * of PostgreSQL the URL must point at the database directly.
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import type { EventEmitter } from 'node:events';
import { Client } from 'pg';

export interface PgListenClient extends EventEmitter {
  /** Not in `@types/pg`; set by `pg` once connected. */
  processID?: number | null;
  connect(): Promise<unknown>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}

export interface PgListenerOptions {
  connectionString?: string;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** Heartbeat period (default 30 s) and the time its answer may take (10 s). */
  heartbeatMs?: number;
  heartbeatTimeoutMs?: number;
  /** Test seam: the production client is a `pg.Client`. */
  createClient?: () => PgListenClient;
}

export const PG_LISTENER_OPTIONS = Symbol('PG_LISTENER_OPTIONS');

const CHANNEL = /^[a-z_][a-z0-9_]{0,62}$/i;

/** Connection settings of the listener: it must notice a dead socket (M2). */
export interface PgClientConfig {
  connectionString: string;
  keepAlive: boolean;
  keepAliveInitialDelayMillis: number;
  connectionTimeoutMillis: number;
}

export function pgClientConfig(connectionString: string): PgClientConfig {
  return {
    connectionString,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  };
}

@Injectable()
export class PgNotificationListener implements OnModuleDestroy {
  private readonly logger = new Logger(PgNotificationListener.name);
  private readonly channels = new Map<string, Set<(payload: string) => void>>();
  private readonly connectedHandlers = new Set<() => void>();
  private client: PgListenClient | null = null;
  private ready = false;
  private closed = false;
  private started: Promise<void> | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private failures = 0;

  constructor(
    @Optional()
    @Inject(PG_LISTENER_OPTIONS)
    private readonly options: PgListenerOptions = {},
  ) {}

  /** PID of the listening backend, for diagnostics and tests. */
  get backendPid(): number | null {
    return this.client?.processID ?? null;
  }

  /** Resolves once the first connection attempt finished (it may have failed). */
  start(): Promise<void> {
    this.started ??= this.attempt();
    return this.started;
  }

  subscribe(channel: string, handler: (payload: string) => void): () => void {
    if (!CHANNEL.test(channel)) throw new Error('Invalid LISTEN channel name');
    let handlers = this.channels.get(channel);
    if (!handlers) {
      handlers = new Set();
      this.channels.set(channel, handlers);
      if (this.ready) this.listen(channel);
    }
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  }

  /** Runs after every successful (re)connect, once LISTEN is in place. */
  onConnected(handler: () => void): () => void {
    this.connectedHandlers.add(handler);
    return () => {
      this.connectedHandlers.delete(handler);
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.stopHeartbeat();
    const client = this.client;
    this.client = null;
    this.ready = false;
    await client?.end().catch(() => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  private listen(channel: string): void {
    this.client?.query(`LISTEN "${channel}"`).catch(() => undefined);
  }

  private async attempt(): Promise<void> {
    if (this.closed) return;
    let client: PgListenClient;
    try {
      client = this.options.createClient?.() ?? this.createPgClient();
    } catch {
      this.logger.error('LISTEN connection is not configured');
      this.retry();
      return;
    }
    this.client = client;
    client.on(
      'notification',
      (message: { channel: string; payload?: string }) =>
        this.dispatch(message.channel, message.payload ?? ''),
    );
    // An idle connection error is followed by `end`; both mean "lost".
    client.on('error', () => this.lost(client));
    client.on('end', () => this.lost(client));
    try {
      await client.connect();
      for (const channel of this.channels.keys()) {
        await client.query(`LISTEN "${channel}"`);
      }
    } catch {
      this.lost(client);
      return;
    }
    if (this.client !== client) return;
    this.ready = true;
    this.failures = 0;
    this.startHeartbeat(client);
    for (const handler of this.connectedHandlers) handler();
  }

  private createPgClient(): PgListenClient {
    const connectionString =
      this.options.connectionString ?? process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    return new Client(pgClientConfig(connectionString));
  }

  private dispatch(channel: string, payload: string): void {
    for (const handler of this.channels.get(channel) ?? []) {
      try {
        handler(payload);
      } catch {
        this.logger.error('A notification handler threw');
      }
    }
  }

  private lost(client: PgListenClient): void {
    if (client !== this.client) return;
    this.client = null;
    this.ready = false;
    this.stopHeartbeat();
    client.end().catch(() => undefined);
    this.logger.warn('LISTEN connection lost; reconnecting');
    this.retry();
  }

  /** `SELECT 1` on a timer; a failure or a silence is a lost connection. */
  private startHeartbeat(client: PgListenClient): void {
    this.stopHeartbeat();
    const { heartbeatMs = 30_000, heartbeatTimeoutMs = 10_000 } = this.options;
    this.heartbeatTimer = setInterval(() => {
      const timeout = new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error('heartbeat timeout')),
          heartbeatTimeoutMs,
        );
        timer.unref();
      });
      Promise.race([client.query('SELECT 1'), timeout]).catch(() =>
        this.lost(client),
      );
    }, heartbeatMs);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private retry(): void {
    if (this.closed) return;
    const { initialBackoffMs = 200, maxBackoffMs = 10_000 } = this.options;
    const base = Math.min(maxBackoffMs, initialBackoffMs * 2 ** this.failures);
    this.failures += 1;
    const delay = Math.round(base / 2 + Math.random() * (base / 2));
    this.retryTimer = setTimeout(() => void this.attempt(), delay);
    this.retryTimer.unref();
  }
}
