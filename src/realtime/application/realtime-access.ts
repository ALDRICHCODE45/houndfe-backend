/**
 * Access of a stream's recipient (unit 8; contract §5.3, §10.1 R5): is the user
 * still active, still a member of the tenant, and do they still hold
 * `read:ChatbotRequest`? The check also returns the CASL ability, which the
 * rows of that delivery are built with (R12), so a revoked `read:CustomerPhone`
 * masks the very next event.
 *
 * `AccessGate` shares one check among every delivery of a user inside a short
 * window (a burst of events costs one check per user, not one per event) and
 * among concurrent callers (one in-flight query per user).
 */
import type { PermissionCheck } from '../../chatbot-requests/domain/resolve-permissions';
import { STREAM_LIMITS, type RevokedReason } from '../domain/realtime-events';

export type AccessResult =
  | { ok: true; ability: PermissionCheck }
  | { ok: false; reason: RevokedReason };

export interface AccessPort {
  /** Throws when the lookup fails (a failure is never read as "revoked"). */
  check(tenantId: string, userId: string): Promise<AccessResult>;
}

export const REALTIME_ACCESS = Symbol('REALTIME_ACCESS');

interface Entry {
  at: number;
  result: Promise<AccessResult>;
}

export class AccessGate implements AccessPort {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly source: AccessPort,
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = STREAM_LIMITS.accessCacheMs,
  ) {}

  /** Seeds a fresh result (the guards just verified it at connect time). */
  prime(tenantId: string, userId: string, ability: PermissionCheck): void {
    this.entries.set(this.key(tenantId, userId), {
      at: this.now(),
      result: Promise.resolve({ ok: true, ability }),
    });
  }

  check(tenantId: string, userId: string): Promise<AccessResult> {
    const key = this.key(tenantId, userId);
    const cached = this.entries.get(key);
    if (cached && this.now() - cached.at < this.ttlMs) return cached.result;
    const result = this.source.check(tenantId, userId);
    const entry: Entry = { at: this.now(), result };
    this.entries.set(key, entry);
    // A failed lookup must not be served again from the cache.
    result.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    this.prune();
    return result;
  }

  /** Drops entries nobody can use any more; bounded by the connected users. */
  private prune(): void {
    if (this.entries.size < 1_000) return;
    const cutoff = this.now() - this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (entry.at < cutoff) this.entries.delete(key);
    }
  }

  private key(tenantId: string, userId: string): string {
    return `${tenantId}:${userId}`;
  }
}
