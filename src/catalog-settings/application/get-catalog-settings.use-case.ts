import { Inject, Injectable } from '@nestjs/common';
import {
  CATALOG_SETTINGS_REPOSITORY,
  ICatalogSettingsRepository,
} from '../domain/catalog-settings.repository';
import { CatalogSettingsInternalResult } from '../domain/tenant-catalog-settings.aggregate';

export class CatalogSettingsNotFoundError extends Error {
  constructor(public readonly tenantId: string) {
    super(`Catalog settings not found for tenant ${tenantId}`);
  }
}
export interface GetCatalogSettingsInput {
  tenantId: string;
}
/** WU3A3 — paired response payload: internal result + default-context coverage. */
export interface GetCatalogSettingsWithCoverageResult {
  settings: CatalogSettingsInternalResult;
  defaultContextProductCount: number | null;
}

@Injectable()
export class GetCatalogSettingsUseCase {
  constructor(
    @Inject(CATALOG_SETTINGS_REPOSITORY)
    private readonly repository: ICatalogSettingsRepository,
  ) {}
  async execute({
    tenantId,
  }: GetCatalogSettingsInput): Promise<CatalogSettingsInternalResult> {
    const settings = await this.repository.findByTenantId(tenantId);
    if (!settings) throw new CatalogSettingsNotFoundError(tenantId);
    return settings.toInternalResult();
  }
  /**
   * WU3A3 — same as `execute` but also evaluates default-context coverage so
   * the controller can emit `DEFAULT_CONTEXT_HAS_NO_VALID_PRICES` warnings
   * without injecting the repository directly.
   */
  async executeWithCoverage({
    tenantId,
  }: GetCatalogSettingsInput): Promise<GetCatalogSettingsWithCoverageResult> {
    const settings = await this.repository.findByTenantId(tenantId);
    if (!settings) throw new CatalogSettingsNotFoundError(tenantId);
    const defaultBinding = settings.defaultBinding;
    const defaultContextProductCount = defaultBinding
      ? await this.repository.countDefaultContextCoverage(
          tenantId,
          defaultBinding.globalPriceListId,
        )
      : null;
    return {
      settings: settings.toInternalResult(),
      defaultContextProductCount,
    };
  }
}
