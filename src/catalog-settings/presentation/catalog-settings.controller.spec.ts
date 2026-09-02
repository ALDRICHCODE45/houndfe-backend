/**
 * WU3A3b — CatalogSettingsController spec (GET route).
 *
 * Covers:
 *   - `@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)` at the
 *     class level.
 *   - `@RequirePermissions(['read', 'TenantCatalogSettings'])` on the GET route.
 *   - Same-tenant GET delegates to `executeWithCoverage` and returns the
 *     committed response mapper output (including coverage warnings).
 *   - JWT/path tenant mismatch denies BEFORE the use case is invoked.
 *   - Cross-tenant access is allowed only when the request CASL ability
 *     carries `manage:all` (no role-name inference).
 */
import { NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { PERMISSIONS_KEY } from '../../auth/authorization/decorators/require-permissions.decorator';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import type { AppAbility } from '../../auth/authorization/domain/permission';
import type { CatalogSettingsInternalResult } from '../domain/tenant-catalog-settings.aggregate';
import { GetCatalogSettingsUseCase } from '../application/get-catalog-settings.use-case';
import { toCatalogSettingsResponseDto } from '../dto/catalog-settings-response.dto';
import { CatalogSettingsController } from './catalog-settings.controller';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

const internalResult = (
  tenantId = TENANT_A,
): CatalogSettingsInternalResult => ({
  tenantId,
  catalogPublished: true,
  effectivePublication: true,
  priceContexts: [
    { priceListId: 'pl-1', name: 'Retail', isCatalogDefault: true },
    { priceListId: 'pl-2', name: 'Wholesale', isCatalogDefault: false },
  ],
  stockPresentationDefault: { mode: 'CUSTOM_QUANTITY', customQuantity: 5 },
  updatedAt: '2024-01-01T00:00:00.000Z',
});

const user = (tenantId: string | null): AuthenticatedUser =>
  ({
    userId: 'user-1',
    email: 'user@example.test',
    tenantId,
    tenantSlug: 'slug',
    isSuperAdmin: tenantId === null,
  }) as AuthenticatedUser;

const ability = (allowsManageAll: boolean): AppAbility =>
  ({ can: jest.fn(() => allowsManageAll) }) as unknown as AppAbility;

describe('CatalogSettingsController', () => {
  let executeWithCoverage: jest.Mock;
  let controller: CatalogSettingsController;

  beforeEach(() => {
    executeWithCoverage = jest.fn(({ tenantId }: { tenantId: string }) =>
      Promise.resolve({
        settings: internalResult(tenantId),
        defaultContextProductCount: 3,
      }),
    );
    controller = new CatalogSettingsController({
      executeWithCoverage,
    } as unknown as GetCatalogSettingsUseCase);
  });

  describe('guard/permission wiring', () => {
    it('declares class-level JwtAuthGuard, TenantContextGuard, PermissionsGuard', () => {
      const guards = Reflect.getMetadata(
        GUARDS_METADATA,
        CatalogSettingsController,
      ) as unknown[];
      expect(guards).toHaveLength(3);
      expect(guards).toContain(JwtAuthGuard);
      expect(guards).toContain(TenantContextGuard);
      expect(guards).toContain(PermissionsGuard);
    });

    it('GET requires (read, TenantCatalogSettings)', () => {
      // NestJS `SetMetadata` defines method metadata on the handler function
      // itself (descriptor.value), so read it from there.
      const descriptor = Object.getOwnPropertyDescriptor(
        CatalogSettingsController.prototype,
        'getSettings',
      );
      const handler = descriptor?.value as object | undefined;
      expect(handler).toBeDefined();
      const perms = Reflect.getMetadata(PERMISSIONS_KEY, handler as object) as
        | Array<[string, string]>
        | undefined;
      expect(perms).toEqual([['read', 'TenantCatalogSettings']]);
    });
  });

  describe('GET /tenants/:tenantId/catalog-settings', () => {
    it('same-tenant caller gets the committed mapper output with coverage', async () => {
      const result = await controller.getSettings(
        TENANT_A,
        user(TENANT_A),
        {} as never,
      );
      expect(executeWithCoverage).toHaveBeenCalledTimes(1);
      expect(executeWithCoverage).toHaveBeenCalledWith({ tenantId: TENANT_A });
      expect(result).toEqual(
        toCatalogSettingsResponseDto(internalResult(), {
          defaultContextProductCount: 3,
        }),
      );
      expect(result.warnings).toEqual([]);
    });

    it('zero default-context coverage surfaces the coverage warning', async () => {
      executeWithCoverage.mockResolvedValue({
        settings: internalResult(),
        defaultContextProductCount: 0,
      });
      const result = await controller.getSettings(
        TENANT_A,
        user(TENANT_A),
        {} as never,
      );
      expect(result.warnings).toEqual(['DEFAULT_CONTEXT_HAS_NO_VALID_PRICES']);
    });

    it('JWT/path tenant mismatch denies before the use case runs', async () => {
      await expect(
        controller.getSettings(TENANT_B, user(TENANT_A), {
          ability: ability(false),
        } as never),
      ).rejects.toThrow(NotFoundException);
      expect(executeWithCoverage).not.toHaveBeenCalled();
    });

    it('missing request ability denies a cross-tenant caller', async () => {
      await expect(
        controller.getSettings(TENANT_B, user(TENANT_A), {} as never),
      ).rejects.toThrow(NotFoundException);
      expect(executeWithCoverage).not.toHaveBeenCalled();
    });

    it('manage:all ability permits the cross-tenant target', async () => {
      const result = await controller.getSettings(TENANT_B, user(TENANT_A), {
        ability: ability(true),
      } as never);
      expect(executeWithCoverage).toHaveBeenCalledTimes(1);
      expect(executeWithCoverage).toHaveBeenCalledWith({ tenantId: TENANT_B });
      expect(result.tenantId).toBe(TENANT_B);
    });
  });
});
