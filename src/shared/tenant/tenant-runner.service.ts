/**
 * TenantRunnerService — establishes a tenant-scoped CLS context for non-HTTP
 * entry points (Inngest step bodies, scheduled jobs, outbox dispatchers).
 *
 * The HTTP request path sets the same CLS keys in `TenantContextGuard`
 * (`tenantId` / `userId` / `tenantSlug` / `isSuperAdmin`). Background flows
 * have no request, so they MUST seed the context explicitly — and they MUST
 * seed ONLY from the event payload (the `tenantId` parameter), never from
 * any inherited CLS scope, otherwise a previous request's tenant could leak
 * into a system flow.
 *
 * Contract (verified by `tenant-runner.service.spec.ts`):
 *
 *   - Opens a fresh `cls.run()` scope, so context never leaks between calls.
 *   - Seeds:
 *       tenantId     = the supplied `tenantId`
 *       userId       = SYSTEM_ACTOR_ID   (system-driven, never an authenticated user)
 *       isSuperAdmin = false             (system runs under tenant rules)
 *       tenantSlug   = null              (system has no slug context)
 *   - Returns the callback's value verbatim.
 *   - Propagates callback rejections (errors must surface to the caller —
 *     otherwise the dedicated low-stock outbox dispatcher could swallow
 *     failures and lose alerts).
 *
 * Spec: `openspec/changes/low-stock-alerts/specs/stock-alerts/spec.md`
 * (Scenario "Tenant id required in every payload" — the handler uses ONLY
 * the payload's `tenantId`, not `getTenantId()` from CLS, because this
 * service is the ONLY source of CLS seeding for system flows).
 */
import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { TenantClsStore } from './tenant-cls-store.interface';

/**
 * Sentinel `userId` for system-driven CLS scopes (Inngest handlers, outbox
 * dispatchers, scheduled jobs). Stable across releases so `User` audit
 * tables that reference it remain consistent. Deliberately NOT a UUID — a
 * known constant makes accidental collisions with real user IDs impossible
 * to miss during a migration review.
 */
export const SYSTEM_ACTOR_ID = 'system';

@Injectable()
export class TenantRunnerService {
  constructor(private readonly cls: ClsService<TenantClsStore>) {}

  /**
   * Run `fn` inside a fresh CLS scope seeded with the supplied `tenantId`
   * and the SYSTEM_ACTOR_ID posture. Returns whatever `fn` resolves to.
   *
   * Throws synchronously (before opening any CLS scope) when `tenantId` is
   * missing or whitespace-only. This guard is load-bearing: a blank
   * `tenantId` would otherwise seed CLS with `''`/`undefined` and silently
   * bypass every tenant-scoped repository's CLS lookup. Background flows
   * (Inngest step bodies, outbox dispatchers, scheduled jobs) have no
   * request context to fall back on, so the guard is the only line of
   * defense against a missing `tenantId` in an event payload.
   */
  async runWithTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    const trimmed = tenantId?.trim();
    if (!trimmed) {
      throw new Error(
        'runWithTenant: tenantId is required for a system-scoped run',
      );
    }
    return this.cls.run(async () => {
      this.cls.set('tenantId', trimmed);
      this.cls.set('userId', SYSTEM_ACTOR_ID);
      this.cls.set('isSuperAdmin', false);
      this.cls.set('tenantSlug', null);
      return fn();
    });
  }
}
