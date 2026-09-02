/**
 * Spec coverage (WU3A2 — GET response mapping only):
 *   - configured settings map 1:1 with pass-through `priceContexts` ordering;
 *   - empty/default state supported by the use-case contract maps to
 *     `priceContexts: []` with no warnings;
 *   - coverage warning mapping: zero coverage on an existing default context
 *     emits `DEFAULT_CONTEXT_HAS_NO_VALID_PRICES`; positive, unevaluated, or
 *     default-less coverage emits nothing.
 */
import { CatalogSettingsInternalResult } from '../domain/tenant-catalog-settings.aggregate';
import { toCatalogSettingsResponseDto } from './catalog-settings-response.dto';

const UPDATED_AT = '2025-01-15T10:30:00.000Z';

function configuredResult(
  overrides: Partial<CatalogSettingsInternalResult> = {},
): CatalogSettingsInternalResult {
  return {
    tenantId: 'tenant-1',
    catalogPublished: true,
    effectivePublication: true,
    priceContexts: [
      { priceListId: 'pl-b', name: 'Mayoreo', isCatalogDefault: false },
      { priceListId: 'pl-a', name: 'Publico', isCatalogDefault: true },
    ],
    stockPresentationDefault: { mode: 'SYSTEM_STATUS', customQuantity: null },
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

describe('toCatalogSettingsResponseDto', () => {
  describe('configured settings', () => {
    it('maps every approved field without warnings when coverage is not evaluated', () => {
      expect(toCatalogSettingsResponseDto(configuredResult())).toEqual({
        tenantId: 'tenant-1',
        catalogPublished: true,
        effectivePublication: true,
        priceContexts: [
          { priceListId: 'pl-b', name: 'Mayoreo', isCatalogDefault: false },
          { priceListId: 'pl-a', name: 'Publico', isCatalogDefault: true },
        ],
        stockPresentationDefault: {
          mode: 'SYSTEM_STATUS',
          customQuantity: null,
        },
        warnings: [],
        updatedAt: UPDATED_AT,
      });
    });

    it('preserves the application ordering of priceContexts instead of re-sorting', () => {
      const dto = toCatalogSettingsResponseDto(configuredResult());

      expect(dto.priceContexts.map((c) => c.priceListId)).toEqual([
        'pl-b',
        'pl-a',
      ]);
    });

    it('maps CUSTOM_QUANTITY presentation with its quantity', () => {
      const dto = toCatalogSettingsResponseDto(
        configuredResult({
          stockPresentationDefault: {
            mode: 'CUSTOM_QUANTITY',
            customQuantity: 0,
          },
        }),
      );

      expect(dto.stockPresentationDefault).toEqual({
        mode: 'CUSTOM_QUANTITY',
        customQuantity: 0,
      });
    });
  });

  describe('empty/default state', () => {
    const emptyResult = configuredResult({
      catalogPublished: false,
      effectivePublication: false,
      priceContexts: [],
    });

    it('maps no price contexts and no warnings', () => {
      const dto = toCatalogSettingsResponseDto(emptyResult);

      expect(dto.priceContexts).toEqual([]);
      expect(dto.warnings).toEqual([]);
      expect(dto.catalogPublished).toBe(false);
      expect(dto.effectivePublication).toBe(false);
    });

    it('emits no coverage warning when there is no default context to cover', () => {
      const dto = toCatalogSettingsResponseDto(emptyResult, {
        defaultContextProductCount: 0,
      });

      expect(dto.warnings).toEqual([]);
    });
  });

  describe('coverage warning mapping', () => {
    it('emits DEFAULT_CONTEXT_HAS_NO_VALID_PRICES when the default context covers zero products', () => {
      const dto = toCatalogSettingsResponseDto(configuredResult(), {
        defaultContextProductCount: 0,
      });

      expect(dto.warnings).toEqual(['DEFAULT_CONTEXT_HAS_NO_VALID_PRICES']);
    });

    it('emits no warning when the default context covers products', () => {
      const dto = toCatalogSettingsResponseDto(configuredResult(), {
        defaultContextProductCount: 7,
      });

      expect(dto.warnings).toEqual([]);
    });

    it('emits no warning when coverage was not evaluated', () => {
      const dto = toCatalogSettingsResponseDto(configuredResult(), {
        defaultContextProductCount: null,
      });

      expect(dto.warnings).toEqual([]);
    });
  });
});
