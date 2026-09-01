import { TenantCatalogSettings } from './tenant-catalog-settings.aggregate';

export const CATALOG_SETTINGS_REPOSITORY = Symbol(
  'CATALOG_SETTINGS_REPOSITORY',
);
/**
 * ICatalogSettingsRepository — bounded port for tenant catalog settings.
 *
 * `actorUserId` is accepted by `replace` for future audit logging (WU3);
 * it is intentionally unused in this implementation.
 *
 * Design contract (§5.2): `replace` uses `runInTransaction`, explicit-tenant
 * `FOR UPDATE` on the tenant row, in-transaction global-ID validation, ordered
 * binding replacement with one promoted default, tenant column updates, and
 * aggregate reload before commit.
 */
export interface ICatalogSettingsRepository {
  findByTenantId(tenantId: string): Promise<TenantCatalogSettings | null>;

  /**
   * Atomically replace the tenant's public price-list bindings and settings.
   *
   * Algorithm inside `runInTransaction`:
   *   1. Lock tenant row with `SELECT ... FROM "tenants" WHERE id = $1 FOR UPDATE`.
   *   2. Validate every `globalPriceListId` in `settings.bindings` against the DB.
   *   3. Sort requested bindings by `globalPriceListId` ascending.
   *   4. Clear all existing bindings' `isCatalogDefault` to `false`.
   *   5. Upsert (idempotent) every non-default binding from the sorted set.
   *   6. Delete every existing binding whose `globalPriceListId` is not in the requested set.
   *   7. Promote exactly one `isCatalogDefault` for the selected default.
   *   8. Update `Tenant.catalogPublished` and stock-presentation columns.
   *   9. Reload the aggregate and return it.
   *
   * @param settings  the fully-formed aggregate to persist
   * @param actorUserId  caller identity (unused until WU3 audit logging)
   */
  replace(
    settings: TenantCatalogSettings,
    actorUserId: string,
  ): Promise<TenantCatalogSettings>;

  /**
   * Return the subset of `ids` that exist as `GlobalPriceList` rows.
   * Used by application layer to resolve named context objects for responses.
   */
  findGlobalPriceListsByIds(
    ids: string[],
  ): Promise<Array<{ id: string; name: string }>>;

  /**
   * Count products that have a positive `priceCents` in the given
   * `globalPriceListId` for the tenant — used for coverage warnings.
   */
  countDefaultContextCoverage(
    tenantId: string,
    globalPriceListId: string,
  ): Promise<number>;
}
