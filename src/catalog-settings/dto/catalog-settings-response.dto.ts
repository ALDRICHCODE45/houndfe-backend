import {
  CatalogSettingsInternalResult,
  CatalogStockPresentationValue,
} from '../domain/tenant-catalog-settings.aggregate';

/**
 * GET catalog-settings HTTP response contract (design.md §5.3).
 *
 * Pure presentation mapping over the internal result already produced by
 * `GetCatalogSettingsUseCase`; no repository access and no extra service
 * layer. `priceContexts` ordering is passed through unchanged, so the
 * deterministic ordering from the domain/application layer is what clients see.
 */
export type CatalogSettingsWarningCode = 'DEFAULT_CONTEXT_HAS_NO_VALID_PRICES';

export interface CatalogSettingsPriceContextDto {
  priceListId: string;
  name: string;
  isCatalogDefault: boolean;
}

export interface CatalogSettingsResponseDto {
  tenantId: string;
  catalogPublished: boolean;
  effectivePublication: boolean;
  priceContexts: CatalogSettingsPriceContextDto[];
  stockPresentationDefault: {
    mode: CatalogStockPresentationValue;
    customQuantity: number | null;
  };
  warnings: CatalogSettingsWarningCode[];
  updatedAt: string;
}

/**
 * `defaultContextProductCount` is the value the caller obtains from
 * `ICatalogSettingsRepository.countDefaultContextCoverage` (WU2b); `null`
 * means coverage was not evaluated, so no coverage warning is emitted.
 */
export interface CatalogSettingsCoverage {
  defaultContextProductCount: number | null;
}

const NO_COVERAGE_EVALUATED: CatalogSettingsCoverage = {
  defaultContextProductCount: null,
};

function buildWarnings(
  result: CatalogSettingsInternalResult,
  coverage: CatalogSettingsCoverage,
): CatalogSettingsWarningCode[] {
  const hasDefaultContext = result.priceContexts.some(
    (context) => context.isCatalogDefault,
  );
  const count = coverage.defaultContextProductCount;
  if (!hasDefaultContext || count === null) return [];
  return count <= 0 ? ['DEFAULT_CONTEXT_HAS_NO_VALID_PRICES'] : [];
}

export function toCatalogSettingsResponseDto(
  result: CatalogSettingsInternalResult,
  coverage: CatalogSettingsCoverage = NO_COVERAGE_EVALUATED,
): CatalogSettingsResponseDto {
  return {
    tenantId: result.tenantId,
    catalogPublished: result.catalogPublished,
    effectivePublication: result.effectivePublication,
    priceContexts: result.priceContexts.map((context) => ({
      priceListId: context.priceListId,
      name: context.name,
      isCatalogDefault: context.isCatalogDefault,
    })),
    stockPresentationDefault: {
      mode: result.stockPresentationDefault.mode,
      customQuantity: result.stockPresentationDefault.customQuantity,
    },
    warnings: buildWarnings(result, coverage),
    updatedAt: result.updatedAt,
  };
}
