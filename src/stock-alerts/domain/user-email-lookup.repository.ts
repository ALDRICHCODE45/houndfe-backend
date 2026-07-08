/**
 * PORT: IUserEmailLookup (Driven Port).
 *
 * Slice F.2 of `low-stock-alerts`. The Inngest handler's
 * `resolve-recipients` step expands `NotificationRecipient`
 * user-ids into deliverable email addresses by joining through
 * `User`. Inactive users (`isActive=false`) are filtered out so
 * dormant accounts never receive alerts.
 *
 * Tenant scoping — CRITICAL.
 *
 * `TenantMembership` is the join table that links a global `User`
 * identity to a `Tenant` (via `tenantId + userId + roleId`). It is
 * **NOT** in `TENANT_SCOPED_MODELS` (see
 * `src/shared/tenant/tenant-scoped-models.constant.ts`), so the
 * tenant-id injection client extension does **NOT** auto-filter
 * `tenantMembership.findMany` calls. **The adapter MUST pass
 * `where.tenantId` explicitly** — using the CLS-seeded tenant id
 * from `tenantRunner.runWithTenant(tenantId, ...)` — or the query
 * will read memberships from EVERY tenant the user belongs to and
 * the cross-tenant→empty safety net is bypassed.
 *
 * This is the only barrier against cross-tenant email resolution
 * (a user with `users.id = U` and `tenant_memberships` rows for
 * both `tenant-A` and `tenant-B` would otherwise leak `tenant-B`'s
 * email into `tenant-A`'s alert). The unit test
 * `prisma-user-email-lookup.repository.spec.ts` pins the
 * (a) `isActive=true` predicate and the (b) `tenantId` predicate;
 * do NOT remove either — deleting `where.tenantId` will fail that
 * spec.
 *
 * Why a separate port (vs. importing `UsersService` directly)?
 * Keeps the Inngest function module free of user-management
 * dependencies; the adapter is a single-purpose lookup that
 * does exactly what the notification flow needs and nothing
 * else.
 */
export interface IUserEmailLookup {
  /**
   * Resolve a list of user-ids to active, deduped emails.
   * Returns `[]` when no users match (never returns null).
   * Order is unspecified.
   */
  resolveEmailsByUserIds(userIds: string[]): Promise<string[]>;
}

export const USER_EMAIL_LOOKUP = Symbol.for('UserEmailLookup');
