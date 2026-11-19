/**
 * Wakes the bot's long-polls when a feed item commits (R7). One `NOTIFY` per
 * enqueue carries the tenant id and nothing else; the replica's shared LISTEN
 * connection fans it out to the waiters of that tenant. A (re)connect wakes
 * every waiter, because a `NOTIFY` sent while the connection was down is gone:
 * the woken poll re-reads from its last cursor, so nothing is lost.
 */
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PgNotificationListener } from '../../shared/realtime/pg-notification-listener';
import { FEED_CHANNEL } from '../domain/chatbot-feed';
import type {
  FeedWaiter,
  FeedWakeupPort,
} from '../application/chatbot-feed.service';

@Injectable()
export class PgFeedWakeup implements FeedWakeupPort, OnModuleDestroy {
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly unsubscribe: Array<() => void>;
  private shuttingDown = false;

  constructor(private readonly listener: PgNotificationListener) {
    this.unsubscribe = [
      listener.subscribe(FEED_CHANNEL, (tenantId) => this.wake(tenantId)),
      listener.onConnected(() => {
        for (const tenantId of this.waiters.keys()) this.wake(tenantId);
      }),
    ];
  }

  get closing(): boolean {
    return this.shuttingDown;
  }

  /**
   * Shutdown: wake every waiter so its long-poll answers now instead of
   * holding the server open for up to 25 s, and mark the wake-up closed so the
   * woken polls do not arm again.
   */
  onModuleDestroy(): void {
    this.shuttingDown = true;
    this.unsubscribe.forEach((off) => off());
    for (const tenantId of [...this.waiters.keys()]) this.wake(tenantId);
  }

  /** Resolves once the LISTEN connection was attempted, then registers. */
  async arm(tenantId: string): Promise<FeedWaiter> {
    await this.listener.start();
    let signaled = this.shuttingDown;
    let release: (() => void) | null = null;
    const fire = () => {
      signaled = true;
      release?.();
    };
    let set = this.waiters.get(tenantId);
    if (!set) {
      set = new Set();
      this.waiters.set(tenantId, set);
    }
    set.add(fire);
    return {
      wait: (timeoutMs, signal) =>
        new Promise<void>((resolve) => {
          if (signaled || signal?.aborted) return resolve();
          const timer = setTimeout(done, timeoutMs);
          function done() {
            clearTimeout(timer);
            signal?.removeEventListener('abort', done);
            release = null;
            resolve();
          }
          release = done;
          signal?.addEventListener('abort', done, { once: true });
        }),
      dispose: () => {
        set.delete(fire);
        if (set.size === 0 && this.waiters.get(tenantId) === set) {
          this.waiters.delete(tenantId);
        }
      },
    };
  }

  private wake(tenantId: string): void {
    for (const fire of [...(this.waiters.get(tenantId) ?? [])]) fire();
  }
}
