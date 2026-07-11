/**
 * Slice D.1 — TenantRunnerService tests.
 *
 * `TenantRunnerService.runWithTenant(tenantId, fn)` runs `fn` inside a fresh
 * `cls.run()` scope, seeding the SAME keys the request path uses
 * (`tenantId` / `userId` / `isSuperAdmin` / `tenantSlug`), so every existing
 * tenant-scoped repository resolves to the payload's tenant — without
 * inheriting anything from a parent request.
 *
 * The service is the ONLY place that establishes tenant context for Inngest
 * step bodies, so its contract is load-bearing:
 *
 *   - Sets `tenantId` to the supplied value.
 *   - Sets `userId` to a SYSTEM_ACTOR_ID sentinel (system-driven flow —
 *     never an authenticated user).
 *   - Sets `isSuperAdmin` to `false` (system runs under tenant rules, not
 *     super-admin bypass — consistent with `TenantContextGuard` rejecting
 *     `!tenantId && !isSuperAdmin`).
 *   - Clears `tenantSlug` (system has no slug context).
 *   - Returns the callback's value verbatim.
 *   - Does NOT leak context across calls (each `runWithTenant` is a fresh
 *     CLS scope — verified by interleaving two different tenants).
 *
 * Spec: `openspec/changes/low-stock-alerts/specs/stock-alerts/spec.md`
 * (Scenario "Tenant id required in every payload" — handler uses ONLY the
 * payload's `tenantId`, not `getTenantId()` from CLS — this service is what
 * establishes that isolation).
 */
import { TenantRunnerService, SYSTEM_ACTOR_ID } from './tenant-runner.service';
import type { ClsService } from 'nestjs-cls';
import type { TenantClsStore } from './tenant-cls-store.interface';

/**
 * Minimal CLS stub that mirrors the production semantics we care about:
 *   - `run(cb)` opens a NEW isolated store, runs `cb`, and discards the store.
 *   - `set/get` only operate against the currently-active store.
 *
 * We DO NOT use the real `ClsService` because `nestjs-cls` binds itself to
 * the request lifecycle via AsyncLocalStorage — mocking at this seam keeps
 * the spec purely synchronous and hermetic.
 */
function makeCls(): {
  cls: jest.Mocked<ClsService<TenantClsStore>>;
  activeStore: () => Partial<TenantClsStore>;
} {
  let active: Partial<TenantClsStore> | null = null;

  const cls = {
    set: jest.fn((key: keyof TenantClsStore | string, value: unknown) => {
      if (!active) {
        throw new Error('cls.set called outside cls.run scope');
      }
      (active as Record<string, unknown>)[key as string] = value;
    }),
    get: jest.fn((key: keyof TenantClsStore | string) => {
      if (!active) return undefined;
      return (active as Record<string, unknown>)[key as string];
    }),
    run: jest.fn(async (cb: () => Promise<unknown>) => {
      const previous = active;
      active = {};
      try {
        return await cb();
      } finally {
        active = previous;
      }
    }),
  } as unknown as jest.Mocked<ClsService<TenantClsStore>>;

  return {
    cls,
    activeStore: () => active ?? {},
  };
}

describe('SYSTEM_ACTOR_ID (D.1)', () => {
  it('is a non-empty string sentinel distinct from any real user id', () => {
    expect(typeof SYSTEM_ACTOR_ID).toBe('string');
    expect(SYSTEM_ACTOR_ID.length).toBeGreaterThan(0);
    // Stable sentinel — guard against accidental change.
    expect(SYSTEM_ACTOR_ID).toBe('system');
  });
});

describe('TenantRunnerService.runWithTenant (D.1)', () => {
  it('seeds tenantId to the supplied value inside the CLS scope', async () => {
    const { cls, activeStore } = makeCls();
    const runner = new TenantRunnerService(cls);

    let observed: {
      tenantId?: unknown;
      userId?: unknown;
      isSuperAdmin?: unknown;
    } = {};
    await runner.runWithTenant('tenant-A', async () => {
      observed = activeStore() as typeof observed;
    });

    expect(observed.tenantId).toBe('tenant-A');
    expect(cls.set).toHaveBeenCalledWith('tenantId', 'tenant-A');
  });

  it('seeds userId to SYSTEM_ACTOR_ID and isSuperAdmin=false (system posture)', async () => {
    const { cls, activeStore } = makeCls();
    const runner = new TenantRunnerService(cls);

    let observed: Record<string, unknown> = {};
    await runner.runWithTenant('tenant-A', async () => {
      observed = activeStore() as Record<string, unknown>;
    });

    expect(observed.userId).toBe(SYSTEM_ACTOR_ID);
    expect(observed.isSuperAdmin).toBe(false);
    expect(cls.set).toHaveBeenCalledWith('userId', SYSTEM_ACTOR_ID);
    expect(cls.set).toHaveBeenCalledWith('isSuperAdmin', false);
  });

  it('clears tenantSlug so a parent request slug never leaks into system flows', async () => {
    const { cls, activeStore } = makeCls();
    const runner = new TenantRunnerService(cls);

    let observed: Record<string, unknown> = {};
    await runner.runWithTenant('tenant-A', async () => {
      observed = activeStore() as Record<string, unknown>;
    });

    expect(observed.tenantSlug).toBeNull();
    expect(cls.set).toHaveBeenCalledWith('tenantSlug', null);
  });

  it('returns the callback value verbatim (forwarding T)', async () => {
    const { cls } = makeCls();
    const runner = new TenantRunnerService(cls);

    const out = await runner.runWithTenant('tenant-A', async () => {
      return { ok: true, payload: [1, 2, 3] };
    });

    expect(out).toEqual({ ok: true, payload: [1, 2, 3] });
  });

  it('propagates callback rejections unchanged (errors must surface to the caller)', async () => {
    const { cls } = makeCls();
    const runner = new TenantRunnerService(cls);

    await expect(
      runner.runWithTenant('tenant-A', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('does NOT leak tenantId between sequential runs (each scope is isolated)', async () => {
    // Critical: a buggy implementation that mutates a singleton store
    // would let tenant-A's id bleed into a later tenant-B run.
    const { cls, activeStore } = makeCls();
    const runner = new TenantRunnerService(cls);

    const seen: unknown[] = [];
    await runner.runWithTenant('tenant-A', async () => {
      seen.push(activeStore().tenantId);
    });
    await runner.runWithTenant('tenant-B', async () => {
      seen.push(activeStore().tenantId);
    });
    await runner.runWithTenant('tenant-C', async () => {
      seen.push(activeStore().tenantId);
    });

    expect(seen).toEqual(['tenant-A', 'tenant-B', 'tenant-C']);
  });

  it('triangulates: two interleaved tenants never see each other inside a single run', async () => {
    // Harder isolation case — coroutine-style interleaving inside a single
    // async function. Our CLS is one scope per `run` invocation, so the
    // second `runWithTenant` call MUST observe tenant-B even though the
    // first one is still awaited above.
    const { cls, activeStore } = makeCls();
    const runner = new TenantRunnerService(cls);

    let innerSeenDuringOuter: unknown = undefined;
    await runner.runWithTenant('tenant-A', async () => {
      // While inside tenant-A's scope, start a nested run that runs in
      // its OWN CLS scope — the outer scope's tenantId must not bleed in.
      await runner.runWithTenant('tenant-B', async () => {
        innerSeenDuringOuter = activeStore().tenantId;
      });
      // After the nested call, the outer scope's tenant must still be A.
      expect(activeStore().tenantId).toBe('tenant-A');
    });

    expect(innerSeenDuringOuter).toBe('tenant-B');
  });

  describe('runWithTenant tenantId guard (D-hardening)', () => {
    it('throws when tenantId is empty string (no CLS scope opened, fn never invoked)', async () => {
      const { cls } = makeCls();
      const runner = new TenantRunnerService(cls);

      const fn = jest.fn().mockResolvedValue('should-not-run');

      await expect(runner.runWithTenant('', fn)).rejects.toThrow(
        /tenantId is required/,
      );
      expect(fn).not.toHaveBeenCalled();
      expect(cls.run).not.toHaveBeenCalled();
      expect(cls.set).not.toHaveBeenCalled();
    });

    it('throws when tenantId is whitespace-only (treated as missing)', async () => {
      const { cls } = makeCls();
      const runner = new TenantRunnerService(cls);

      const fn = jest.fn().mockResolvedValue('should-not-run');

      await expect(runner.runWithTenant('   ', fn)).rejects.toThrow(
        /tenantId is required/,
      );
      expect(fn).not.toHaveBeenCalled();
      expect(cls.run).not.toHaveBeenCalled();
    });

    it('throws when tenantId is undefined (defensive — primitive param may be untyped)', async () => {
      const { cls } = makeCls();
      const runner = new TenantRunnerService(cls);

      const fn = jest.fn().mockResolvedValue('should-not-run');

      await expect(
        runner.runWithTenant(undefined as unknown as string, fn),
      ).rejects.toThrow(/tenantId is required/);
      expect(fn).not.toHaveBeenCalled();
      expect(cls.run).not.toHaveBeenCalled();
    });

    it('accepts a non-empty tenantId that contains internal whitespace (only leading/trailing must be trimmed)', async () => {
      const { cls, activeStore } = makeCls();
      const runner = new TenantRunnerService(cls);

      let observed: unknown = undefined;
      await runner.runWithTenant('  tenant-A  ', async () => {
        observed = activeStore().tenantId;
      });

      // We trim before assigning so the seeded value is canonical.
      expect(observed).toBe('tenant-A');
    });
  });

  it('does NOT leak a parent CLS tenantId into the child scope (defensive clear)', async () => {
    // Simulate a parent request having seeded tenantId='tenant-parent'.
    // The runner opens its OWN `cls.run()` scope and OVERWRITES with the
    // supplied tenantId. Even if the implementation re-used the store
    // instead of opening a new scope, the explicit set() must win.
    const store: Partial<TenantClsStore> = { tenantId: 'tenant-parent' };
    const cls = {
      set: jest.fn((key: keyof TenantClsStore | string, value: unknown) => {
        (store as Record<string, unknown>)[key as string] = value;
      }),
      get: jest.fn(
        (key: keyof TenantClsStore | string) =>
          (store as Record<string, unknown>)[key as string],
      ),
      run: jest.fn(async (cb: () => Promise<unknown>) => cb()),
    } as unknown as jest.Mocked<ClsService<TenantClsStore>>;

    const runner = new TenantRunnerService(cls);

    await runner.runWithTenant('tenant-child', async () => {
      expect(store.tenantId).toBe('tenant-child');
    });
  });
});
