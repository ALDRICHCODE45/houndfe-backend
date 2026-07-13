/**
 * PromotionsService - Application layer (Use Cases).
 *
 * Orchestrates domain logic and infrastructure for the Promotion aggregate.
 * Handles: Promotion CRUD + manual end operation.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Promotion } from './domain/promotion.entity';
import {
  normalizePromotionDateRange,
  startOfBusinessDay,
  endOfBusinessDay,
} from './domain/promotion-date-range';
import type {
  IPromotionRepository,
  PromotionFindAllQuery,
} from './domain/promotion.repository';
import { PROMOTION_REPOSITORY } from './domain/promotion.repository';
import { CreatePromotionDto } from './dto/create-promotion.dto';
import {
  CustomerScopeEnum,
  DayOfWeekEnum,
  DiscountTypeEnum,
  PromotionMethodEnum,
  PromotionTargetTypeEnum,
  PromotionTypeEnum,
} from './dto/create-promotion.dto';
import { UpdatePromotionDto } from './dto/update-promotion.dto';
import { PromotionQueryDto } from './dto/promotion-query.dto';
import {
  EntityNotFoundError,
  InvalidArgumentError,
} from '../shared/domain/domain-error';
import { PrismaService } from '../shared/prisma/prisma.service';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import type {
  CreatePromotionParams,
  CustomerScope,
  DayOfWeek,
  DiscountType,
  PromotionMethod,
  PromotionTargetItemData,
  PromotionTargetType,
  PromotionType,
  TargetSide,
} from './domain/promotion.entity';

@Injectable()
export class PromotionsService {
  /**
   * Business timezone for promotion date-range normalization.
   *
   * Configured via the `PROMOTIONS_BUSINESS_TIMEZONE` env var. Default
   * `America/Mexico_City` matches the production tenant location; the
   * variable exists so a tenant in a different zone can shift the
   * window without code changes. The helper validates the zone is a
   * known IANA name at first use, so a typo fails loudly at boot.
   */
  private readonly businessTimezone: string;

  constructor(
    @Inject(PROMOTION_REPOSITORY)
    private readonly repo: IPromotionRepository,
    private readonly prisma: PrismaService,
    private readonly tenantPrisma: TenantPrismaService,
    configService: ConfigService,
  ) {
    this.businessTimezone = configService.get<string>(
      'PROMOTIONS_BUSINESS_TIMEZONE',
      'America/Mexico_City',
    );
  }

  // ==================== Create ====================

  async create(dto: CreatePromotionDto) {
    // ── Validate type cannot be changed (already enforced by entity, but guard early) ──

    // ── Validate referenced target IDs ──
    const targetItems = await this.resolveTargetItems(dto);

    // ── Validate customers (only for SPECIFIC scope) ──
    const customers = await this.resolveCustomers(dto);

    // ── Validate price lists ──
    const priceLists = await this.resolvePriceLists(dto);

    // ── Normalize date range to business-day boundaries in the
    //    configured timezone. The frontend serializes date-only picks
    //    as UTC-midnight; storing that instant verbatim makes the
    //    effective-status comparison drift by the business-tz offset
    //    (see `promotion-date-range.ts` for the full contract). ──
    const normalizedDates = normalizePromotionDateRange(
      {
        startDate: dto.startDate ? new Date(dto.startDate) : null,
        endDate: dto.endDate ? new Date(dto.endDate) : null,
      },
      this.businessTimezone,
    );

    // ── Build domain entity (entity validates type-specific rules) ──
    const promotion = Promotion.create({
      id: crypto.randomUUID(),
      title: dto.title,
      type: dto.type as PromotionType,
      method: dto.method as PromotionMethod,
      startDate: normalizedDates.startDate,
      endDate: normalizedDates.endDate,
      customerScope: dto.customerScope as CustomerScope,
      discountType: dto.discountType as DiscountType,
      discountValue: dto.discountValue ?? null,
      minPurchaseAmountCents: dto.minPurchaseAmountCents ?? null,
      appliesTo: dto.appliesTo as PromotionTargetType,
      buyQuantity: dto.buyQuantity ?? null,
      getQuantity: dto.getQuantity ?? null,
      getDiscountPercent: dto.getDiscountPercent ?? null,
      buyTargetType: dto.buyTargetType as PromotionTargetType,
      getTargetType: dto.getTargetType as PromotionTargetType,
    });

    // ── Attach relations ──
    promotion.targetItems = targetItems;
    this.assertAdvancedSideTargets(promotion.type, {
      buyTargetType: promotion.buyTargetType,
      getTargetType: promotion.getTargetType,
      targetItems: promotion.targetItems,
    });
    promotion.customers = customers;
    promotion.priceLists = priceLists;
    promotion.daysOfWeek = (dto.daysOfWeek ?? []).map((day) => ({
      id: crypto.randomUUID(),
      day: day as DayOfWeek,
    }));

    return this.repo.save(promotion);
  }

  // ==================== FindAll ====================

  async findAll(query: PromotionQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const repoQuery: PromotionFindAllQuery = {
      page,
      limit,
      type: query.type,
      status: query.status,
      method: query.method,
      customerScope: query.customerScope,
      search: query.search,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
    };

    const { data, total } = await this.repo.findAll(repoQuery);
    const now = new Date();

    const responses = data.map((p) => p.toResponse(now));
    await this.enrichVariantTargetItems(responses);

    return {
      data: responses,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ==================== FindOne ====================

  async findOne(id: string) {
    const promotion = await this.repo.findById(id);
    if (!promotion) throw new EntityNotFoundError('Promotion', id);
    const response = promotion.toResponse();
    await this.enrichVariantTargetItems([response]);
    return response;
  }

  // ==================== Update ====================

  async update(id: string, dto: UpdatePromotionDto) {
    const existing = await this.repo.findById(id);
    if (!existing) throw new EntityNotFoundError('Promotion', id);

    // Type cannot be changed after creation
    if (Object.hasOwn(dto, 'type')) {
      throw new InvalidArgumentError(
        'Cannot change promotion type after creation',
        'INVALID_FIELD_CHANGE',
      );
    }

    // Build merged scalar payload and force full re-validation through entity.create()
    const mergedForValidation = this.buildMergedValidationParams(existing, dto);
    Promotion.create(mergedForValidation);

    existing.title = mergedForValidation.title;
    existing.startDate = mergedForValidation.startDate ?? null;
    existing.endDate = mergedForValidation.endDate ?? null;
    existing.customerScope = mergedForValidation.customerScope ?? 'ALL';
    existing.discountType = mergedForValidation.discountType ?? null;
    existing.discountValue = mergedForValidation.discountValue ?? null;
    existing.minPurchaseAmountCents =
      mergedForValidation.minPurchaseAmountCents ?? null;
    existing.appliesTo = mergedForValidation.appliesTo ?? null;
    existing.buyQuantity = mergedForValidation.buyQuantity ?? null;
    existing.getQuantity = mergedForValidation.getQuantity ?? null;
    existing.getDiscountPercent =
      mergedForValidation.getDiscountPercent ?? null;
    existing.buyTargetType = mergedForValidation.buyTargetType ?? null;
    existing.getTargetType = mergedForValidation.getTargetType ?? null;

    const targetInput = this.buildTargetResolutionInput(existing, dto);
    existing.targetItems = await this.resolveTargetItems(targetInput);
    this.assertAdvancedSideTargets(existing.type, {
      buyTargetType: existing.buyTargetType,
      getTargetType: existing.getTargetType,
      targetItems: existing.targetItems,
    });

    if (dto.customerIds !== undefined) {
      existing.customers = await this.resolveCustomers({
        ...targetInput,
        customerIds: dto.customerIds,
      });
    }
    if (dto.priceListIds !== undefined) {
      existing.priceLists = await this.resolvePriceLists({
        ...targetInput,
        priceListIds: dto.priceListIds,
      });
    }
    if (dto.daysOfWeek !== undefined) {
      existing.daysOfWeek = (dto.daysOfWeek ?? []).map((day) => ({
        id: crypto.randomUUID(),
        day: day as DayOfWeek,
      }));
    }

    // Recompute the persisted `status` from the (possibly new) date window.
    // Honours `manuallyEnded` as a permanent override, so a manually-ended
    // promotion stays ENDED across title-only edits, and a promotion whose
    // dates just moved back inside the window flips ACTIVE again.
    existing.recomputeStatus();

    existing.updatedAt = new Date();
    const saved = await this.repo.save(existing);
    return saved.toResponse();
  }

  // ==================== Remove ====================

  async remove(id: string): Promise<void> {
    const existing = await this.repo.findById(id);
    if (!existing) throw new EntityNotFoundError('Promotion', id);
    await this.repo.delete(id);
  }

  // ==================== EndPromotion ====================

  async endPromotion(id: string) {
    const promotion = await this.repo.findById(id);
    if (!promotion) throw new EntityNotFoundError('Promotion', id);

    // call entity.end() to compute the endDate
    promotion.end();

    await this.repo.updateStatus(id, 'ENDED', promotion.endDate);

    // Re-fetch to return fresh data
    const updated = await this.repo.findById(id);
    if (!updated) throw new EntityNotFoundError('Promotion', id);
    return updated.toResponse();
  }

  // ==================== Private Helpers ====================

  /**
   * Read-model enrichment: stamp variant context onto VARIANTS
   * targetItems across one or more promotion response objects.
   *
   * `PromotionTargetItem.targetId` has NO FK to Variant/Product
   * (schema.prisma) — so a Prisma `include` cannot bring the parent
   * product. We do a SEPARATE, tenant-scoped batch lookup instead:
   * collect every distinct VARIANTS targetId across the whole page
   * into a single `variant.findMany` (one `IN (...)`, no N+1), build a
   * lookup map, then mutate each VARIANTS item in place, adding the
   * response-only fields `productId`, `variantName`, `productName`.
   *
   * Enrichment is keyed by `targetType === 'VARIANTS'` (any side —
   * DEFAULT/BUY/GET). Non-VARIANTS items are left untouched. A
   * targetId not present in the lookup (e.g. the variant was deleted
   * but the promotion still references it) is skipped silently — the
   * new fields stay absent and nothing throws.
   */
  private async enrichVariantTargetItems(
    responses: Array<Record<string, unknown>>,
  ): Promise<void> {
    type MutableTargetItem = PromotionTargetItemData & {
      productId?: string;
      variantName?: string;
      productName?: string;
    };

    // Collect all VARIANTS items across every response, and the set of
    // distinct variant ids to look up in one shot.
    const variantItems: MutableTargetItem[] = [];
    const variantIds = new Set<string>();

    for (const response of responses) {
      const items = response.targetItems as MutableTargetItem[] | undefined;
      if (!items?.length) continue;
      for (const item of items) {
        if (item.targetType === 'VARIANTS') {
          variantItems.push(item);
          variantIds.add(item.targetId);
        }
      }
    }

    if (variantIds.size === 0) return;

    const tenantClient = this.tenantPrisma.getClient();
    const variants = await tenantClient.variant.findMany({
      where: { id: { in: [...variantIds] } },
      select: {
        id: true,
        productId: true,
        name: true,
        product: { select: { name: true } },
      },
    });

    const byId = new Map<
      string,
      { productId: string; variantName: string; productName: string }
    >();
    for (const v of variants) {
      byId.set(v.id, {
        productId: v.productId,
        variantName: v.name,
        productName: v.product?.name ?? '',
      });
    }

    for (const item of variantItems) {
      const ctx = byId.get(item.targetId);
      if (!ctx) continue; // deleted variant still referenced — skip silently
      item.productId = ctx.productId;
      item.variantName = ctx.variantName;
      item.productName = ctx.productName;
    }
  }

  /**
   * Resolve target items from DTO.
   * - For DEFAULT side: uses dto.targetItems
   * - For BUY side: uses dto.buyTargetItems (ADVANCED)
   * - For GET side: uses dto.getTargetItems (ADVANCED)
   * Also validates that referenced IDs exist in the corresponding tables.
   */
  private async resolveTargetItems(
    dto: CreatePromotionDto,
  ): Promise<PromotionTargetItemData[]> {
    const result: PromotionTargetItemData[] = [];
    const uniqueKeys = new Set<string>();

    const pushUnique = (item: PromotionTargetItemData): void => {
      const key = `${item.side}:${item.targetType}:${item.targetId}`;
      if (uniqueKeys.has(key)) {
        throw new InvalidArgumentError(
          `Duplicate target mapping for ${item.side}/${item.targetType}/${item.targetId}`,
          'duplicate_target',
        );
      }
      uniqueKeys.add(key);
      result.push(item);
    };

    // DEFAULT targets (PRODUCT_DISCOUNT, BUY_X_GET_Y)
    if (dto.targetItems?.length) {
      await this.validateTargetIds(dto.targetItems);
      for (const item of dto.targetItems) {
        pushUnique({
          id: crypto.randomUUID(),
          side: 'DEFAULT' as TargetSide,
          targetType: item.targetType as PromotionTargetType,
          targetId: item.targetId,
        });
      }
    }

    // BUY targets (ADVANCED)
    if (dto.buyTargetItems?.length) {
      const buyType = dto.buyTargetType as PromotionTargetType;
      if (buyType) {
        const items = dto.buyTargetItems.map((i) => ({
          targetType: buyType,
          targetId: i.targetId,
        }));
        await this.validateTargetIds(items);
        for (const item of dto.buyTargetItems) {
          pushUnique({
            id: crypto.randomUUID(),
            side: 'BUY' as TargetSide,
            targetType: buyType,
            targetId: item.targetId,
          });
        }
      }
    }

    // GET targets (ADVANCED)
    if (dto.getTargetItems?.length) {
      const getType = dto.getTargetType as PromotionTargetType;
      if (getType) {
        const items = dto.getTargetItems.map((i) => ({
          targetType: getType,
          targetId: i.targetId,
        }));
        await this.validateTargetIds(items);
        for (const item of dto.getTargetItems) {
          pushUnique({
            id: crypto.randomUUID(),
            side: 'GET' as TargetSide,
            targetType: getType,
            targetId: item.targetId,
          });
        }
      }
    }

    return result;
  }

  private buildMergedValidationParams(
    existing: Promotion,
    dto: UpdatePromotionDto,
  ): CreatePromotionParams {
    // ── Date normalization ──
    //
    // update() can change startDate/endDate, clear them with null, or
    // leave them untouched (omitted). For each branch we must
    // produce the exact value the entity will persist:
    //
    //   1. dto.startDate is omitted → keep `existing.startDate` as-is
    //      (it's already a stored business-day boundary — do NOT
    //      re-normalize it or DST rounding could shift it).
    //   2. dto.startDate === null → explicit null (clear the bound).
    //   3. dto.startDate is a string → re-normalize the new pick.
    //
    // Same three-way branch for endDate. The timezone comes from the
    // same business-tz source as create().
    const tz = this.businessTimezone;
    const mergedStartDate =
      dto.startDate === undefined
        ? existing.startDate
        : dto.startDate === null
          ? null
          : startOfBusinessDay(new Date(dto.startDate), tz);
    const mergedEndDate =
      dto.endDate === undefined
        ? existing.endDate
        : dto.endDate === null
          ? null
          : endOfBusinessDay(new Date(dto.endDate), tz);

    return {
      id: existing.id,
      title: dto.title ?? existing.title,
      type: existing.type,
      method: existing.method,
      startDate: mergedStartDate,
      endDate: mergedEndDate,
      customerScope: (dto.customerScope ??
        existing.customerScope) as CustomerScope,
      discountType: (dto.discountType ?? existing.discountType) as DiscountType,
      discountValue:
        dto.discountValue !== undefined
          ? dto.discountValue
          : existing.discountValue,
      minPurchaseAmountCents:
        dto.minPurchaseAmountCents !== undefined
          ? dto.minPurchaseAmountCents
          : existing.minPurchaseAmountCents,
      appliesTo:
        dto.appliesTo !== undefined
          ? (dto.appliesTo as PromotionTargetType)
          : existing.appliesTo,
      buyQuantity:
        dto.buyQuantity !== undefined ? dto.buyQuantity : existing.buyQuantity,
      getQuantity:
        dto.getQuantity !== undefined ? dto.getQuantity : existing.getQuantity,
      getDiscountPercent:
        dto.getDiscountPercent !== undefined
          ? dto.getDiscountPercent
          : existing.getDiscountPercent,
      buyTargetType:
        dto.buyTargetType !== undefined
          ? (dto.buyTargetType as PromotionTargetType)
          : existing.buyTargetType,
      getTargetType:
        dto.getTargetType !== undefined
          ? (dto.getTargetType as PromotionTargetType)
          : existing.getTargetType,
    };
  }

  private buildTargetResolutionInput(
    existing: Promotion,
    dto: UpdatePromotionDto,
  ): CreatePromotionDto {
    return {
      title: existing.title,
      type: existing.type as PromotionTypeEnum,
      method: existing.method as PromotionMethodEnum,
      appliesTo:
        dto.appliesTo !== undefined
          ? dto.appliesTo
          : ((existing.appliesTo ?? undefined) as
              | PromotionTargetTypeEnum
              | undefined),
      buyTargetType:
        dto.buyTargetType !== undefined
          ? dto.buyTargetType
          : ((existing.buyTargetType ?? undefined) as
              | PromotionTargetTypeEnum
              | undefined),
      getTargetType:
        dto.getTargetType !== undefined
          ? dto.getTargetType
          : ((existing.getTargetType ?? undefined) as
              | PromotionTargetTypeEnum
              | undefined),
      targetItems:
        dto.targetItems !== undefined
          ? dto.targetItems
          : existing.targetItems
              .filter((item) => item.side === 'DEFAULT')
              .map((item) => ({
                targetType: item.targetType as PromotionTargetTypeEnum,
                targetId: item.targetId,
              })),
      buyTargetItems:
        dto.buyTargetItems !== undefined
          ? dto.buyTargetItems
          : existing.targetItems
              .filter((item) => item.side === 'BUY')
              .map((item) => ({ targetId: item.targetId })),
      getTargetItems:
        dto.getTargetItems !== undefined
          ? dto.getTargetItems
          : existing.targetItems
              .filter((item) => item.side === 'GET')
              .map((item) => ({ targetId: item.targetId })),
      customerScope: existing.customerScope as CustomerScopeEnum,
      discountType: existing.discountType as DiscountTypeEnum | undefined,
      daysOfWeek: existing.daysOfWeek.map(
        (dayItem) => dayItem.day as DayOfWeekEnum,
      ),
    };
  }

  private assertAdvancedSideTargets(
    type: Promotion['type'],
    params: {
      buyTargetType: PromotionTargetType | null;
      getTargetType: PromotionTargetType | null;
      targetItems: PromotionTargetItemData[];
    },
  ): void {
    if (type !== 'ADVANCED') return;

    if (params.buyTargetType) {
      const hasBuyTargets = params.targetItems.some(
        (item) =>
          item.side === 'BUY' && item.targetType === params.buyTargetType,
      );
      if (!hasBuyTargets) {
        throw new InvalidArgumentError(
          'ADVANCED promotions require buyTargetItems when buyTargetType is specified',
          'advanced_missing_targets',
        );
      }
    }

    if (params.getTargetType) {
      const hasGetTargets = params.targetItems.some(
        (item) =>
          item.side === 'GET' && item.targetType === params.getTargetType,
      );
      if (!hasGetTargets) {
        throw new InvalidArgumentError(
          'ADVANCED promotions require getTargetItems when getTargetType is specified',
          'advanced_missing_targets',
        );
      }
    }
  }

  /**
   * Validate that all targetIds exist in their respective tables.
   * Throws InvalidArgumentError if any ID is not found.
   */
  private async validateTargetIds(
    items: Array<{ targetType: string; targetId: string }>,
  ): Promise<void> {
    const tenantClient = this.tenantPrisma.getClient();
    const byType: Record<string, string[]> = {};
    for (const item of items) {
      byType[item.targetType] = byType[item.targetType] ?? [];
      byType[item.targetType].push(item.targetId);
    }

    for (const [targetType, ids] of Object.entries(byType)) {
      const uniqueIds = [...new Set(ids)];
      let found: Array<{ id: string }>;

      switch (targetType) {
        case 'CATEGORIES':
          found = await this.prisma.category.findMany({
            where: { id: { in: uniqueIds } },
            select: { id: true },
          });
          break;
        case 'BRANDS':
          found = await this.prisma.brand.findMany({
            where: { id: { in: uniqueIds } },
            select: { id: true },
          });
          break;
        case 'PRODUCTS':
          found = await tenantClient.product.findMany({
            where: { id: { in: uniqueIds } },
            select: { id: true },
          });
          break;
        case 'VARIANTS':
          // Tenant-scoped — symmetric with the PRODUCTS branch. Variants
          // are tenant-scoped (`Variant.tenantId`, schema.prisma:~456), so
          // a cross-tenant variant id is filtered out by the tenant
          // middleware and surfaces here as a not-found row.
          found = await tenantClient.variant.findMany({
            where: { id: { in: uniqueIds } },
            select: { id: true },
          });
          break;
        default:
          found = [];
      }

      const foundIds = new Set(found.map((r) => r.id));
      const missing = uniqueIds.find((id) => !foundIds.has(id));
      if (missing) {
        const entityName =
          targetType === 'CATEGORIES'
            ? 'Category'
            : targetType === 'BRANDS'
              ? 'Brand'
              : targetType === 'VARIANTS'
                ? 'Variant'
                : 'Product';
        throw new InvalidArgumentError(
          `${entityName} with id '${missing}' not found`,
          'INVALID_TARGET',
        );
      }
    }
  }

  /**
   * Resolve customer associations.
   * If customerScope is SPECIFIC and customerIds are provided,
   * validates and builds the PromotionCustomer list.
   */
  private async resolveCustomers(
    dto: CreatePromotionDto,
  ): Promise<Array<{ id: string; customerId: string }>> {
    if (!dto.customerIds?.length) return [];

    const tenantClient = this.tenantPrisma.getClient();
    const uniqueIds = [...new Set(dto.customerIds)];
    const found = await tenantClient.customer.findMany({
      where: { id: { in: uniqueIds } },
      select: { id: true },
    });

    const foundIds = new Set(found.map((r) => r.id));
    const missing = uniqueIds.find((id) => !foundIds.has(id));
    if (missing) {
      throw new InvalidArgumentError(
        `Customer with id '${missing}' not found`,
        'INVALID_TARGET',
      );
    }

    return uniqueIds.map((customerId) => ({
      id: crypto.randomUUID(),
      customerId,
    }));
  }

  /**
   * Resolve price list associations.
   */
  private async resolvePriceLists(
    dto: CreatePromotionDto,
  ): Promise<Array<{ id: string; globalPriceListId: string }>> {
    if (!dto.priceListIds?.length) return [];

    const tenantClient = this.tenantPrisma.getClient();
    const uniqueIds = [...new Set(dto.priceListIds)];
    const found = await tenantClient.globalPriceList.findMany({
      where: { id: { in: uniqueIds } },
      select: { id: true },
    });

    const foundIds = new Set(found.map((r) => r.id));
    const missing = uniqueIds.find((id) => !foundIds.has(id));
    if (missing) {
      throw new InvalidArgumentError(
        `PriceList with id '${missing}' not found`,
        'INVALID_TARGET',
      );
    }

    return uniqueIds.map((globalPriceListId) => ({
      id: crypto.randomUUID(),
      globalPriceListId,
    }));
  }
}
