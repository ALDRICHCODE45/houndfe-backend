import type { ICatalogSettingsRepository } from '../domain/catalog-settings.repository';

export const CATALOG_SETTINGS_TRANSACTION = Symbol(
  'CATALOG_SETTINGS_TRANSACTION',
);

/** Caller supplies an already-authorized tenant; the operation owns completion. */
export interface CatalogSettingsTransaction {
  run<T>(
    tenantId: string,
    work: (repository: ICatalogSettingsRepository) => Promise<T>,
  ): Promise<T>;
}

export class CatalogSettingsTransactionOwnershipError extends Error {
  constructor() {
    super('Catalog settings PATCH requires its own transaction');
    this.name = 'CatalogSettingsTransactionOwnershipError';
  }
}
