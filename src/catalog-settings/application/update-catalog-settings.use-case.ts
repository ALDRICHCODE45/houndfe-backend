import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  CATALOG_SETTINGS_REPOSITORY,
  ICatalogSettingsRepository,
} from '../domain/catalog-settings.repository';
import {
  CatalogSettingsInvariantError,
  TenantCatalogSettings,
  type TenantBaseProps,
} from '../domain/tenant-catalog-settings.aggregate';
import { TenantCatalogPriceListBinding } from '../domain/tenant-catalog-price-list.entity';
import { CatalogSettingsNotFoundError } from './get-catalog-settings.use-case';
import {
  toCatalogSettingsResponseDto,
  type CatalogSettingsResponseDto,
} from '../dto/catalog-settings-response.dto';
import type { UpdateCatalogSettingsDto } from '../dto/update-catalog-settings.dto';
import {
  CATALOG_SETTINGS_UPDATED,
  CatalogSettingsUpdatedEvent,
  deriveCatalogSettingsChangedFields,
} from './events/catalog-settings.events';

/**
 * PATCH write input (design.md §5.4). `actorUserId` is forwarded to
 * `replace` and, since WU3B3, into the post-commit audit payload.
 */
export interface UpdateCatalogSettingsInput {
  tenantId: string;
  actorUserId: string;
  data: UpdateCatalogSettingsDto;
}

@Injectable()
export class UpdateCatalogSettingsUseCase {
  constructor(
    @Inject(CATALOG_SETTINGS_REPOSITORY)
    private readonly repository: ICatalogSettingsRepository,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Not-found semantics match GET exactly. Requested list existence is
   * checked through the port query GET uses; in-transaction validation
   * inside `replace` remains the race-safe backstop. The resolved default
   * must be in the resulting public set; every structural invariant is
   * enforced by aggregate construction, never duplicated here. Default-
   * context coverage is resolved from the desired aggregate BEFORE the
   * write, so a coverage read failure can never surface as a PATCH error
   * after the mutation committed. One atomic `replace` persists, and the
   * reloaded aggregate is mapped with the GET mapper (coverage warnings
   * included) so the response matches GET.
   */
  async execute({
    tenantId,
    actorUserId,
    data,
  }: UpdateCatalogSettingsInput): Promise<CatalogSettingsResponseDto> {
    const current = await this.repository.findByTenantId(tenantId);
    if (!current) throw new CatalogSettingsNotFoundError(tenantId);

    const desiredPublicIds =
      data.publicPriceListIds ??
      current.bindings.map((b) => b.globalPriceListId);
    const globalListsById = new Map<string, { id: string; name: string }>();
    if (data.publicPriceListIds !== undefined && desiredPublicIds.length > 0) {
      const found =
        await this.repository.findGlobalPriceListsByIds(desiredPublicIds);
      for (const list of found) globalListsById.set(list.id, list);
      const missing = desiredPublicIds.filter((id) => !globalListsById.has(id));
      if (missing.length > 0)
        throw new CatalogSettingsInvariantError(
          'UNKNOWN_GLOBAL_PRICE_LIST',
          `Global price list(s) not found: ${missing.join(', ')}`,
        );
    }

    // PATCH default resolution: explicit UUID wins, explicit `null`
    // clears, omission keeps the current default binding.
    const resolvedDefaultId =
      data.catalogDefaultPriceListId === null
        ? null
        : (data.catalogDefaultPriceListId ??
          current.defaultBinding?.globalPriceListId ??
          null);
    if (
      resolvedDefaultId !== null &&
      !desiredPublicIds.includes(resolvedDefaultId)
    )
      throw new CatalogSettingsInvariantError(
        'DEFAULT_NOT_PUBLIC',
        `Default price list ${resolvedDefaultId} must be in the public price list set`,
      );

    const updated = this.buildAggregate(
      current,
      desiredPublicIds,
      resolvedDefaultId,
      globalListsById,
      data,
    );
    const defaultBinding = updated.defaultBinding;
    const defaultContextProductCount = defaultBinding
      ? await this.repository.countDefaultContextCoverage(
          tenantId,
          defaultBinding.globalPriceListId,
        )
      : null;
    const saved = await this.repository.replace(updated, actorUserId);
    this.emitUpdatedAudit(tenantId, actorUserId, data);
    return toCatalogSettingsResponseDto(saved.toInternalResult(), {
      defaultContextProductCount,
    });
  }

  /**
   * Best-effort audit (WU3B3): emitted only AFTER `replace` resolves, so a
   * failed validation, coverage lookup, or write never produces an event.
   * Any emission failure is swallowed here — an already-committed PATCH
   * must never reject because auditing could not run. The payload is the
   * allowlisted `CatalogSettingsUpdatedEvent`; values never ride along.
   */
  private emitUpdatedAudit(
    tenantId: string,
    actorUserId: string,
    data: UpdateCatalogSettingsDto,
  ): void {
    try {
      this.eventEmitter.emit(
        CATALOG_SETTINGS_UPDATED,
        new CatalogSettingsUpdatedEvent(
          tenantId,
          actorUserId,
          CATALOG_SETTINGS_UPDATED,
          new Date().toISOString(),
          deriveCatalogSettingsChangedFields(data),
        ),
      );
    } catch {
      // Intentionally ignored: audit/event failures are non-fatal.
    }
  }

  /** Rebuilds the aggregate; `fromPersistence` validates all invariants. */
  private buildAggregate(
    current: TenantCatalogSettings,
    desiredPublicIds: string[],
    resolvedDefaultId: string | null,
    globalListsById: Map<string, { id: string; name: string }>,
    data: UpdateCatalogSettingsDto,
  ): TenantCatalogSettings {
    const existingByGlobalId = new Map(
      current.bindings.map((b) => [b.globalPriceListId, b]),
    );
    const bindings = desiredPublicIds.map((globalPriceListId) => {
      const existing = existingByGlobalId.get(globalPriceListId);
      // Retained lists reuse the persisted binding; new lists take
      // port-resolved names. `replace` treats ids/timestamps as upsert input.
      const globalPriceList =
        existing?.globalPriceList ?? globalListsById.get(globalPriceListId)!;
      return TenantCatalogPriceListBinding.fromPersistence({
        id: existing?.id ?? `pending-${globalPriceListId}`,
        tenantId: current.tenantId,
        globalPriceListId,
        isCatalogDefault: globalPriceListId === resolvedDefaultId,
        createdAt: existing?.createdAt ?? current.updatedAt,
        updatedAt: current.updatedAt,
        globalPriceList,
      });
    });

    const stockPresentation =
      data.stockPresentationDefault ?? current.stockPresentationDefault;
    const tenant: TenantBaseProps = {
      tenantId: current.tenantId,
      isActive: current.isActive,
      catalogPublished: data.catalogPublished ?? current.catalogPublished,
      catalogStockPresentationDefault: stockPresentation.mode,
      catalogStockPresentationDefaultCustomQty:
        stockPresentation.customQuantity ?? null,
      updatedAt: current.updatedAt,
    };
    return TenantCatalogSettings.fromPersistence({ tenant, bindings });
  }
}
