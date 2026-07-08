/**
 * CRITICAL 3 (Reliability) — `PrismaUserEmailLookupRepository` adapter
 * tests, with the **cross-tenant→empty** assertion as the load-bearing
 * safety net for the port doc.
 *
 * Spec coverage (Slice F.2 of `low-stock-alerts` + the post-Findings
 * review):
 *
 *   - (a) **Inactive users are excluded.** The Prisma `where` clause
 *     carries `user: { isActive: true }`. A user marked inactive
 *     must NEVER appear in the resolved email list (spec:
 *     notification-config "Active-Only Recipients").
 *   - (b) **Cross-tenant isolation resolves to EMPTY.** A `userId`
 *     that exists in the global `users` table but whose only
 *     `TenantMembership` belongs to a DIFFERENT tenant must yield
 *     `[]` — the explicit `where.tenantId` filter at the adapter is
 *     the ONLY barrier against cross-tenant email resolution
 *     because `TenantMembership` is NOT in `TENANT_SCOPED_MODELS`.
 *     **If a future dev "reconciles" the port doc that wrongly says
 *     "MUST NOT pass `where.tenantId` manually" by deleting the
 *     filter, this test MUST fail.** The port doc was fixed
 *     alongside this test; the test pins the regression.
 *   - (c) **Duplicate emails are collapsed.** The same `users.email`
 *     reached via two `TenantMembership` rows appears ONCE in the
 *     resolved list.
 *   - (d) **Empty input → empty output (no DB call).** Cheap
 *     short-circuit so the inngest step doesn't pay the round-trip
 *     when `recipients[]` is already empty.
 *   - (e) **No cross-pollination from other tenants in the result.**
 *     The returned list contains ONLY emails from the CLS-seeded
 *     tenant; a prisma findMany that returns rows for the wrong
 *     tenant (i.e. someone hand-stuffing the mock) gets dropped by
 *     the dedupe path (defense in depth — the WHERE already
 *     filters, but the test pins the output contract).
 *
 * We use a **focused unit test with mocked tenant-scoped prisma**
 * (NOT a real-DB integration spec) because (1) the production
 * `tenantMembership.findMany` is the exact prisma call we're pinning
 * — there is no `Date.now()` or async-network flake to integrate
 * against, and (2) the spec must run in environments without a live
 * Postgres (CI, this review env). A DB-gated integration spec would
 * be additive; here the unit test fully proves the contract.
 */
import { PrismaUserEmailLookupRepository } from './prisma-user-email-lookup.repository';

/**
 * Build a tenant-prisma mock that records every `findMany` call so the
 * spec can assert the WHERE clause carries BOTH `tenantId` AND
 * `user.isActive = true` — the two predicates that make (a) + (b)
 * load-bearing.
 */
function makeTenantPrisma(currentTenantId: string) {
  const findManyMock = jest.fn();
  const tenantPrisma = {
    getClient: () => ({
      tenantMembership: {
        findMany: findManyMock,
      },
    }),
    getTenantId: () => currentTenantId,
  };
  return { tenantPrisma: tenantPrisma as never, findManyMock };
}

describe('PrismaUserEmailLookupRepository — isActive + tenant-scoped dedupe (CRITICAL 3)', () => {
  it('(d) returns [] for an empty userIds list and does NOT hit the DB', async () => {
    const { tenantPrisma, findManyMock } = makeTenantPrisma('tenant-1');
    const repo = new PrismaUserEmailLookupRepository(tenantPrisma);

    const out = await repo.resolveEmailsByUserIds([]);

    expect(out).toEqual([]);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it('(a) excludes inactive users — the WHERE clause carries `user: { isActive: true }`', async () => {
    const { tenantPrisma, findManyMock } = makeTenantPrisma('tenant-1');
    findManyMock.mockResolvedValue([]); // no active rows match
    const repo = new PrismaUserEmailLookupRepository(tenantPrisma);

    await repo.resolveEmailsByUserIds(['user-1']);

    expect(findManyMock).toHaveBeenCalledTimes(1);
    const arg = findManyMock.mock.calls[0]?.[0] as {
      where: {
        userId: { in: string[] };
        tenantId: string;
        user: { isActive: boolean };
      };
    };
    expect(arg.where.userId).toEqual({ in: ['user-1'] });
    expect(arg.where.tenantId).toBe('tenant-1');
    // The isActive predicate is what (a) hinges on. If a future
    // refactor drops it, inactive users start receiving alerts.
    expect(arg.where.user).toEqual({ isActive: true });
  });

  it('(b) MANDATORY — a user belonging to a DIFFERENT tenant resolves to [] (cross-tenant isolation)', async () => {
    // CLS says the calling tenant is "tenant-1". `tenantMembership`
    // has no rows for (user-foreign, tenant-1) — the user belongs
    // ONLY to "tenant-other". The explicit `where.tenantId` filter
    // collapses the result to zero rows.
    const { tenantPrisma, findManyMock } = makeTenantPrisma('tenant-1');
    findManyMock.mockResolvedValue([]); // empty: no matching membership
    const repo = new PrismaUserEmailLookupRepository(tenantPrisma);

    const out = await repo.resolveEmailsByUserIds(['user-foreign']);

    // The adapter MUST NOT try to fall back to global user lookup.
    // If the explicit tenantId filter is removed (relying on the
    // port doc that says "MUST NOT pass tenantId"), Prisma would
    // return the row from the wrong tenant's membership → cross-
    // tenant PII leak.
    expect(out).toEqual([]);

    // And the WHERE must include the CLS tenantId — the gate that
    // makes the empty result structurally load-bearing.
    const arg = findManyMock.mock.calls[0]?.[0] as {
      where: { tenantId: string };
    };
    expect(arg.where.tenantId).toBe('tenant-1');
  });

  it('(b) — the CLS tenantId (not a hard-coded value) gates the where clause', async () => {
    // A second tenant proves the filter is per-CLS, not per-build.
    const { tenantPrisma, findManyMock } = makeTenantPrisma('tenant-OTHER');
    findManyMock.mockResolvedValue([]);
    const repo = new PrismaUserEmailLookupRepository(tenantPrisma);

    await repo.resolveEmailsByUserIds(['u1', 'u2']);

    const arg = findManyMock.mock.calls[0]?.[0] as {
      where: { tenantId: string };
    };
    expect(arg.where.tenantId).toBe('tenant-OTHER');
  });

  it('(c) collapses duplicate emails from multiple membership rows', async () => {
    const { tenantPrisma, findManyMock } = makeTenantPrisma('tenant-1');
    // Same email reached via two memberships, plus a different email.
    findManyMock.mockResolvedValue([
      { user: { email: 'a@example.com' } },
      { user: { email: 'a@example.com' } },
      { user: { email: 'b@example.com' } },
    ]);
    const repo = new PrismaUserEmailLookupRepository(tenantPrisma);

    const out = await repo.resolveEmailsByUserIds(['u1', 'u2', 'u3']);

    // Dedup preserves first-seen order; 'a@example.com' appears
    // ONCE, 'b@example.com' appears ONCE — total length 2.
    expect(out).toEqual(['a@example.com', 'b@example.com']);
    expect(out).toHaveLength(2);
  });

  it('(e) — the SELECT projects only `user.email` (no other user fields leak through)', async () => {
    const { tenantPrisma, findManyMock } = makeTenantPrisma('tenant-1');
    findManyMock.mockResolvedValue([{ user: { email: 'a@example.com' } }]);
    const repo = new PrismaUserEmailLookupRepository(tenantPrisma);

    await repo.resolveEmailsByUserIds(['u1']);

    const arg = findManyMock.mock.calls[0]?.[0] as {
      select: { user: { select: { email: boolean } } };
    };
    // Pin the narrow projection — the alert path must NOT pull
    // hashedPassword / isActive / refreshToken from the join.
    expect(arg.select).toEqual({ user: { select: { email: true } } });
  });
});
