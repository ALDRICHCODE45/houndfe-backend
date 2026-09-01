import { TenantCatalogSettings } from './tenant-catalog-settings.aggregate';

export const CATALOG_SETTINGS_REPOSITORY = Symbol(
  'CATALOG_SETTINGS_REPOSITORY',
);
export interface ICatalogSettingsRepository {
  findByTenantId(tenantId: string): Promise<TenantCatalogSettings | null>;
}
