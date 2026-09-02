/**
 * WU3A3b + WU3B4 — CatalogSettingsController spec (GET + PATCH routes).
 *
 * Covers:
 *   - `@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)` at the
 *     class level.
 *   - `@RequirePermissions(['read', 'TenantCatalogSettings'])` on GET and
 *     `['update', 'TenantCatalogSettings']` on PATCH.
 *   - Same-tenant GET delegates to `executeWithCoverage` and returns the
 *     committed response mapper output (including coverage warnings).
 *   - Same-tenant PATCH delegates the exact `{ tenantId, actorUserId, data }`
 *     input to `UpdateCatalogSettingsUseCase.execute` and returns its DTO.
 *   - JWT/path tenant mismatch denies BEFORE any use case is invoked on both
 *     routes.
 *   - Cross-tenant access is allowed only when the request CASL ability
 *     carries `manage:all` (no role-name inference).
 *   - PATCH carries exact core-Nest `@Header('Cache-Control', 'no-store')`
 *     response-header metadata (no interceptor/provider registration needed);
 *     GET stays header-free.
 *   - PATCH's `tenantId` route argument is bound to the `tenantId` path key
 *     with an actual `ParseUUIDPipe` instance via `ROUTE_ARGS_METADATA`.
 *
 * Pipe-level notes: this harness instantiates the controller directly (no
 * Nest application), so `ParseUUIDPipe`/`ValidationPipe` execution is not
 * exercised here; malformed-UUID and strict-DTO rejection are covered at
 * pipe/DTO level by `update-catalog-settings.dto.spec.ts` and by the global
 * bootstrap pipes (`whitelist` + `forbidNonWhitelisted`). Route/method
 * metadata is asserted instead so the PATCH wiring is still pinned.
 */
import { NotFoundException, ParseUUIDPipe } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HEADERS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { RequestMethod } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { PERMISSIONS_KEY } from '../../auth/authorization/decorators/require-permissions.decorator';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import type { AppAbility } from '../../auth/authorization/domain/permission';
import type { CatalogSettingsInternalResult } from '../domain/tenant-catalog-settings.aggregate';
import { GetCatalogSettingsUseCase } from '../application/get-catalog-settings.use-case';
import { UpdateCatalogSettingsUseCase } from '../application/update-catalog-settings.use-case';
import type { UpdateCatalogSettingsDto } from '../dto/update-catalog-settings.dto';
import { toCatalogSettingsResponseDto } from '../dto/catalog-settings-response.dto';
import { CatalogSettingsController } from './catalog-settings.controller';

/** Shape of one `ROUTE_ARGS_METADATA` entry (Nest core, ≥ v8). */
type RouteArgMetadata = {
  index: number;
  data?: string;
  pipes?: unknown[];
};

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
  let updateExecute: jest.Mock;
  let controller: CatalogSettingsController;

  beforeEach(() => {
    executeWithCoverage = jest.fn(({ tenantId }: { tenantId: string }) =>
      Promise.resolve({
        settings: internalResult(tenantId),
        defaultContextProductCount: 3,
      }),
    );
    updateExecute = jest.fn(({ tenantId }: { tenantId: string }) =>
      Promise.resolve(
        toCatalogSettingsResponseDto(internalResult(tenantId), {
          defaultContextProductCount: 3,
        }),
      ),
    );
    controller = new CatalogSettingsController(
      { executeWithCoverage } as unknown as GetCatalogSettingsUseCase,
      { execute: updateExecute } as unknown as UpdateCatalogSettingsUseCase,
    );
  });

  /** Reads the handler function for a route method (metadata lives there). */
  const handlerOf = (method: string): object => {
    const descriptor = Object.getOwnPropertyDescriptor(
      CatalogSettingsController.prototype,
      method,
    );
    const handler = descriptor?.value as object | undefined;
    expect(handler).toBeDefined();
    return handler as object;
  };

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
      const handler = handlerOf('getSettings');
      const perms = Reflect.getMetadata(PERMISSIONS_KEY, handler) as
        | Array<[string, string]>
        | undefined;
      expect(perms).toEqual([['read', 'TenantCatalogSettings']]);
    });

    it('PATCH requires (update, TenantCatalogSettings)', () => {
      const handler = handlerOf('updateSettings');
      const perms = Reflect.getMetadata(PERMISSIONS_KEY, handler) as
        | Array<[string, string]>
        | undefined;
      expect(perms).toEqual([['update', 'TenantCatalogSettings']]);
    });

    it('PATCH is mapped to PATCH /tenants/:tenantId/catalog-settings', () => {
      const handler = handlerOf('updateSettings');
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
        RequestMethod.PATCH,
      );
      // `@Patch()` without a path is normalized by Nest to '/'.
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('/');
    });

    it('PATCH carries exact Cache-Control: no-store response-header metadata', () => {
      const handler = handlerOf('updateSettings');
      const headers = Reflect.getMetadata(HEADERS_METADATA, handler) as
        | Array<{ name: string; value: string }>
        | undefined;
      expect(headers).toEqual([{ name: 'Cache-Control', value: 'no-store' }]);
    });

    it('GET sets no Cache-Control response-header metadata', () => {
      const handler = handlerOf('getSettings');
      expect(Reflect.getMetadata(HEADERS_METADATA, handler)).toBeUndefined();
    });
  });

  describe('route argument metadata', () => {
    it('PATCH binds the tenantId route argument to the tenantId path key with a ParseUUIDPipe instance', () => {
      // Unlike `SetMetadata`-based decorators (which define on the handler
      // function itself), parameter decorators define `ROUTE_ARGS_METADATA`
      // on (controller class, method key). Entries are keyed
      // `${paramtype}:${index}` and carry `{ index, data, pipes }`.
      const routeArgs = Reflect.getMetadata(
        ROUTE_ARGS_METADATA,
        CatalogSettingsController,
        'updateSettings',
      ) as Record<string, RouteArgMetadata> | undefined;
      expect(routeArgs).toBeDefined();

      const tenantIdArg = routeArgs?.[`${RouteParamtypes.PARAM}:0`];
      expect(tenantIdArg).toBeDefined();
      expect(tenantIdArg?.index).toBe(0);
      // Bound to the `:tenantId` path key (PARAM paramtype, data key).
      expect(tenantIdArg?.data).toBe('tenantId');
      // An actual pipe instance is wired, not a class or name reference.
      expect(tenantIdArg?.pipes).toHaveLength(1);
      expect(tenantIdArg?.pipes?.[0]).toBeInstanceOf(ParseUUIDPipe);
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

  describe('PATCH /tenants/:tenantId/catalog-settings', () => {
    const patchDto: UpdateCatalogSettingsDto = {
      catalogPublished: true,
      publicPriceListIds: [TENANT_A],
    } as unknown as UpdateCatalogSettingsDto;

    it('same-tenant caller delegates the exact input and returns the DTO', async () => {
      const result = await controller.updateSettings(
        TENANT_A,
        patchDto,
        user(TENANT_A),
        {} as never,
      );
      expect(updateExecute).toHaveBeenCalledTimes(1);
      expect(updateExecute).toHaveBeenCalledWith({
        tenantId: TENANT_A,
        actorUserId: 'user-1',
        data: patchDto,
      });
      expect(executeWithCoverage).not.toHaveBeenCalled();
      expect(result).toEqual(
        toCatalogSettingsResponseDto(internalResult(), {
          defaultContextProductCount: 3,
        }),
      );
    });

    it('JWT/path tenant mismatch denies before the use case runs', async () => {
      await expect(
        controller.updateSettings(TENANT_B, patchDto, user(TENANT_A), {
          ability: ability(false),
        } as never),
      ).rejects.toThrow(NotFoundException);
      expect(updateExecute).not.toHaveBeenCalled();
    });

    it('missing request ability denies a cross-tenant caller', async () => {
      await expect(
        controller.updateSettings(
          TENANT_B,
          patchDto,
          user(TENANT_A),
          {} as never,
        ),
      ).rejects.toThrow(NotFoundException);
      expect(updateExecute).not.toHaveBeenCalled();
    });

    it('manage:all ability permits the cross-tenant target tenant', async () => {
      await controller.updateSettings(TENANT_B, patchDto, user(TENANT_A), {
        ability: ability(true),
      } as never);
      expect(updateExecute).toHaveBeenCalledTimes(1);
      expect(updateExecute).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT_B }),
      );
    });
  });
});
