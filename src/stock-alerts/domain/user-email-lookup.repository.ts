/**
 * PORT: IUserEmailLookup (Driven Port).
 *
 * Slice F.2 of `low-stock-alerts`. The Inngest handler's
 * `resolve-recipients` step expands `NotificationRecipient`
 * user-ids into deliverable email addresses by joining through
 * `User`. Inactive users (`isActive=false`) are filtered out so
 * dormant accounts never receive alerts.
 *
 * Tenant scoping: the call site (`StockAlertsModule.onModuleInit`
 * → `low-stock.functions.ts`) runs the step inside
 * `tenantRunner.runWithTenant(tenantId, ...)`; the adapter uses
 * `TenantPrismaService.getClient()` which auto-joins on
 * `tenant_memberships` via the client extension. The adapter
 * MUST NOT pass `where.tenantId` manually — that would conflict
 * with the CLS-seeded scope.
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
