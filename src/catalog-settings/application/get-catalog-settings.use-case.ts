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
}
