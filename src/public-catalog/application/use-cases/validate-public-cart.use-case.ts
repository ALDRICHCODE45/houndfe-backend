import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { TenantPrismaService } from '../../../shared/prisma/tenant-prisma.service';
import type {
  CartBlockingCode,
  CartValidationResponseDto,
  CartValidationResponseWithContextDto,
  CartValidatedItem,
  CartValidatedItemWithContextDto,
  CartWarningCode,
} from '../dto/cart-validation.dto';
import type { PublicPriceContextDto } from '../dto/public-price-context.dto';
import type {
  IPublicCatalogRepository,
  PublicCartCandidate,
  ResolvedPublicCatalogContext,
} from '../ports/public-catalog.repository';
import { PUBLIC_CATALOG_REPOSITORY } from '../ports/public-catalog.repository';
import { mapStockStatus } from '../../domain/value-objects/stock-status.vo';
import { isEffectivelyPriceHidden } from '../../domain/value-objects/effective-price-hidden.vo';

interface CartInput {
  items: Array<{
    productId: string;
    variantId?: string;
    quantity: number;
  }>;
}

/** F2.WU7 slice 2 — input for the dormant context-explicit cart seam. */
export interface ValidatePublicCartForContextInput {
  /** Guarded public tenant; must match the resolved context. */
  tenant: { id: string; slug: string };
  /** Already resolved by the upstream price-context resolver. */
  context: ResolvedPublicCatalogContext;
  items: CartInput['items'];
}

const BLOCKING_WARNINGS: CartWarningCode[] = [
  'NOT_FOUND',
  'NOT_IN_CATALOG',
  'VARIANT_NOT_FOUND',
  'OUT_OF_STOCK',
];

@Injectable()
export class ValidatePublicCartUseCase {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    @Inject(PUBLIC_CATALOG_REPOSITORY)
    private readonly repo?: IPublicCatalogRepository,
  ) {}

  async execute(input: CartInput): Promise<CartValidationResponseDto> {
    const client = this.tenantPrisma.getClient();

    // F1.WU5d2 — tenant catalog-default compatibility: resolve the
    // tenant's catalog-default global price-list ID exactly once per
    // cart validation request and reuse that exact ID for every item
    // and duplicate. Price acceptance is by exact returned ID only — a
    // tenant-local or same-named shadow price list can never match.
    // A missing resolver, absent method, or empty result fails closed
    // through the existing price-missing (PRICE_HIDDEN) shape below.
    const defaultPriceListId =
      (await this.repo?.findTenantCatalogDefaultPriceListId?.()) ?? null;
    const priceListFilter: Prisma.PriceListWhereInput = defaultPriceListId
      ? { globalPriceListId: defaultPriceListId }
      : { id: { in: [] } };
    const variantPriceFilter: Prisma.VariantPriceWhereInput = defaultPriceListId
      ? { priceList: { globalPriceListId: defaultPriceListId } }
      : { id: { in: [] } };

    const productIds = [...new Set(input.items.map((i) => i.productId))];
    const variantIds = input.items
      .map((i) => i.variantId)
      .filter((id): id is string => id != null);

    const products = await client.product.findMany({
      where: { id: { in: productIds } },
      include: {
        priceLists: {
          where: priceListFilter,
          select: { priceCents: true },
          take: 1,
        },
        variants: {
          ...(variantIds.length > 0
            ? { where: { id: { in: variantIds } } }
            : {}),
          include: {
            variantPrices: {
              where: variantPriceFilter,
              select: { priceCents: true },
              take: 1,
            },
          },
        },
        images: {
          where: { isMain: true, variantId: null },
          take: 1,
          select: { url: true },
        },
      },
    });

    const productMap = new Map(products.map((p) => [p.id, p]));

    let hasHiddenPrice = false;
    const validatedItems: CartValidatedItem[] = [];
    const globalWarnings = new Set<CartWarningCode>();

    for (const item of input.items) {
      const product = productMap.get(item.productId);

      if (!product) {
        validatedItems.push(
          this.notFoundItem(
            item.productId,
            item.variantId ?? null,
            item.quantity,
          ),
        );
        globalWarnings.add('NOT_FOUND');
        continue;
      }

      // F1.WU5d1 — parent publication gate: the row must be a real
      // PRODUCT and included in the online catalog. Evaluated before any
      // variant, stock, or price decision, so an ON variant can never
      // widen a false parent gate. Blocked rows never disclose metadata.
      if (product.type !== 'PRODUCT' || !product.includeInOnlineCatalog) {
        validatedItems.push(
          this.excludedItem(
            'NOT_IN_CATALOG',
            item.productId,
            item.variantId ?? null,
            item.quantity,
          ),
        );
        globalWarnings.add('NOT_IN_CATALOG');
        continue;
      }

      // Resolve variant if requested
      let variant: (typeof products)[number]['variants'][number] | null = null;
      if (item.variantId) {
        variant =
          product.variants?.find((v) => v.id === item.variantId) ?? null;
        if (!variant) {
          validatedItems.push({
            productId: item.productId,
            variantId: item.variantId,
            productName: product.name,
            variantName: null,
            image: product.images[0] ? { url: product.images[0].url } : null,
            quantity: item.quantity,
            unitPriceCents: null,
            lineTotalCents: null,
            availability: 'out_of_stock',
            priceHidden: false,
            warnings: ['VARIANT_NOT_FOUND'],
          });
          globalWarnings.add('VARIANT_NOT_FOUND');
          continue;
        }
        // F1.WU5d1 — an OFF variant is excluded from the public cart via
        // the existing F1 VARIANT_NOT_FOUND path (never WU7 codes), with
        // no name/image disclosure for the excluded row.
        if (variant.catalogPublishMode === 'OFF') {
          validatedItems.push(
            this.excludedItem(
              'VARIANT_NOT_FOUND',
              item.productId,
              item.variantId,
              item.quantity,
            ),
          );
          globalWarnings.add('VARIANT_NOT_FOUND');
          continue;
        }
      }

      const warnings: CartWarningCode[] = [];
      const priceHidden = isEffectivelyPriceHidden(product);

      // Stock check
      const qty = variant ? variant.quantity : product.quantity;
      const minQty = variant ? variant.minQuantity : product.minQuantity;
      const availability = product.useStock
        ? mapStockStatus(qty, minQty)
        : 'available';

      if (availability === 'out_of_stock') {
        warnings.push('OUT_OF_STOCK');
        globalWarnings.add('OUT_OF_STOCK');
      } else if (availability === 'low_stock') {
        warnings.push('LOW_STOCK');
        globalWarnings.add('LOW_STOCK');
      }

      // Price
      let unitPriceCents: number | null = null;
      let lineTotalCents: number | null = null;

      // F1.WU5d2 — fail closed: without an exactly-resolved tenant
      // catalog-default global price list, no price is accepted and the
      // existing price-missing shape (PRICE_HIDDEN warning, null price
      // fields, null total) is reused. No error is invented or thrown,
      // and WU5d1 publication gates above remain fully in force.
      const effectivePriceHidden = priceHidden || defaultPriceListId == null;

      if (effectivePriceHidden) {
        warnings.push('PRICE_HIDDEN');
        globalWarnings.add('PRICE_HIDDEN');
        hasHiddenPrice = true;
      } else {
        unitPriceCents = variant
          ? (variant.variantPrices[0]?.priceCents ?? null)
          : (product.priceLists[0]?.priceCents ?? null);
        lineTotalCents =
          unitPriceCents != null ? unitPriceCents * item.quantity : null;
      }

      validatedItems.push({
        productId: item.productId,
        variantId: item.variantId ?? null,
        productName: product.name,
        variantName: variant?.name ?? null,
        image: product.images[0] ? { url: product.images[0].url } : null,
        quantity: item.quantity,
        unitPriceCents,
        lineTotalCents,
        availability,
        priceHidden: effectivePriceHidden,
        warnings,
      });
    }

    const hasBlocking = validatedItems.some((item) =>
      item.warnings.some((w) => BLOCKING_WARNINGS.includes(w)),
    );

    let totalCents: number | null = null;
    if (!hasHiddenPrice) {
      totalCents = validatedItems.reduce(
        (sum, item) =>
          item.availability === 'out_of_stock' || item.unitPriceCents == null
            ? sum
            : sum + (item.lineTotalCents ?? 0),
        0,
      );
    }

    return {
      valid: !hasBlocking,
      items: validatedItems,
      totalCents,
      warnings: [...globalWarnings],
    };
  }

  /**
   * F2.WU7 slice 2 — dormant, uncalled context-explicit cart reconciliation
   * seam. The guarded tenant and resolved price context arrive upstream;
   * this method never resolves a context and never touches the legacy
   * default-list path or `TenantPrismaService`. Fails closed with the
   * generic `NotFoundException('Not Found')` on tenant/context mismatch
   * (before any repository access) and on an absent optional seam — no
   * optional-chain into undefined, no legacy fallback, no retry.
   *
   * Per-item decision order: catalog-membership miss (uniform redacted
   * `NOT_IN_CATALOG`) → wrong-child/missing variant `VARIANT_NOT_FOUND` →
   * requested OFF variant `VARIANT_NOT_IN_CATALOG` → hidden-price
   * precedence (bypasses allowlist and positive-price checks) → exact
   * selected-list allowlist plus positive price or
   * `PRICE_NOT_AVAILABLE_IN_CONTEXT` → independent stock → totals. Client
   * prices are not part of the input and cannot influence the result;
   * `PRICE_CHANGED` stays dormant.
   */
  async executeForContext(
    input: ValidatePublicCartForContextInput,
  ): Promise<CartValidationResponseWithContextDto> {
    const { tenant, context } = input;

    // Fail closed before any repository access when the request tenant
    // does not match the resolved public price context.
    if (tenant.id !== context.tenantId || tenant.slug !== context.tenantSlug) {
      throw new NotFoundException('Not Found');
    }

    // Optional seam: absent implementation is a generic miss — never an
    // optional-chain into undefined and never a legacy fallback.
    if (!this.repo?.findPublicCartCandidates) {
      throw new NotFoundException('Not Found');
    }

    // Exactly one bulk load of de-duplicated requested IDs.
    const productIds = [...new Set(input.items.map((i) => i.productId))];
    const variantIds = [
      ...new Set(
        input.items
          .map((i) => i.variantId)
          .filter((id): id is string => id != null),
      ),
    ];
    const candidates = await this.repo.findPublicCartCandidates({
      tenantId: tenant.id,
      context,
      productIds,
      variantIds,
    });
    const candidateMap = new Map(candidates.map((c) => [c.id, c]));

    let hasHiddenPrice = false;
    let totalCents = 0;
    const globalWarnings = new Set<CartWarningCode>();
    const items: CartValidatedItemWithContextDto[] = [];

    // Input order and duplicates are preserved in the response.
    for (const item of input.items) {
      const candidate = candidateMap.get(item.productId);

      // Steps 3–5: a missing product and a product failing the effective
      // publication gate share one uniform redacted membership miss.
      if (
        !candidate ||
        candidate.type !== 'PRODUCT' ||
        !candidate.includeInOnlineCatalog
      ) {
        items.push(this.contextualRedactedItem(item, ['NOT_IN_CATALOG']));
        globalWarnings.add('NOT_IN_CATALOG');
        continue;
      }

      let variant: PublicCartCandidate['variants'][number] | null = null;
      if (item.variantId) {
        variant =
          candidate.variants.find((v) => v.id === item.variantId) ?? null;
        if (!variant) {
          items.push(this.contextualRedactedItem(item, ['VARIANT_NOT_FOUND']));
          globalWarnings.add('VARIANT_NOT_FOUND');
          continue;
        }
        if (variant.catalogPublishMode === 'OFF') {
          items.push(
            this.contextualRedactedItem(item, ['VARIANT_NOT_IN_CATALOG']),
          );
          globalWarnings.add('VARIANT_NOT_IN_CATALOG');
          continue;
        }
      }

      const warnings: CartWarningCode[] = [];
      const blockingCodes: CartBlockingCode[] = [];
      const hidden = isEffectivelyPriceHidden(candidate);
      let unitPriceCents: number | null = null;
      let lineTotalCents: number | null = null;

      if (hidden) {
        // Hidden-price precedence bypasses allowlist and positive-price
        // checks; numeric fields stay null and the aggregate is nulled.
        warnings.push('PRICE_HIDDEN');
        globalWarnings.add('PRICE_HIDDEN');
        hasHiddenPrice = true;
      } else {
        // Exact selected-list allowlist (zero rows = every context) plus a
        // positive exact-context price; no default/alternate fallback.
        const allowlisted =
          candidate.catalogPriceLists.length === 0 ||
          candidate.catalogPriceLists.some(
            (l) => l.globalPriceListId === context.globalPriceListId,
          );
        const priceCents = variant
          ? (variant.variantPrices[0]?.priceCents ?? null)
          : (candidate.priceLists[0]?.priceCents ?? null);
        if (!allowlisted || priceCents == null) {
          blockingCodes.push('PRICE_NOT_AVAILABLE_IN_CONTEXT');
          globalWarnings.add('PRICE_NOT_AVAILABLE_IN_CONTEXT');
        } else {
          unitPriceCents = priceCents;
          lineTotalCents = priceCents * item.quantity;
        }
      }

      // Independent operational stock check.
      const qty = variant ? variant.quantity : candidate.quantity;
      const minQty = variant ? variant.minQuantity : candidate.minQuantity;
      const availability = candidate.useStock
        ? mapStockStatus(qty, minQty)
        : 'available';
      if (availability === 'out_of_stock') {
        blockingCodes.push('OUT_OF_STOCK');
        globalWarnings.add('OUT_OF_STOCK');
      } else if (availability === 'low_stock') {
        warnings.push('LOW_STOCK');
        globalWarnings.add('LOW_STOCK');
      }

      const priceBlocked = blockingCodes.includes(
        'PRICE_NOT_AVAILABLE_IN_CONTEXT',
      );
      const blocked = blockingCodes.length > 0;
      items.push({
        productId: item.productId,
        variantId: item.variantId ?? null,
        productName: candidate.name,
        variantName: variant?.name ?? null,
        image: candidate.images[0] ? { url: candidate.images[0].url } : null,
        quantity: item.quantity,
        status: blocked ? 'BLOCKED' : 'VALID',
        blockingCodes,
        warnings: [...blockingCodes, ...warnings],
        // Price-blocked rows carry no price; visible out-of-stock rows
        // retain authoritative line totals.
        unitPriceCents: priceBlocked ? null : unitPriceCents,
        lineTotalCents: priceBlocked ? null : lineTotalCents,
        availability,
        priceHidden: hidden,
      });

      // Blocked lines never contribute to the aggregate total.
      if (!blocked && lineTotalCents != null) {
        totalCents += lineTotalCents;
      }
    }

    const priceContext: PublicPriceContextDto = {
      priceListId: context.globalPriceListId,
      name: context.name,
      isCatalogDefault: context.isCatalogDefault,
    };

    return {
      valid: !items.some((i) => i.status === 'BLOCKED'),
      priceContext,
      items,
      warnings: [...globalWarnings],
      totalCents: hasHiddenPrice ? null : totalCents,
    };
  }

  /** F2.WU7 slice 2 — uniformly redacted membership/publication miss. */
  private contextualRedactedItem(
    item: CartInput['items'][number],
    blockingCodes: [CartBlockingCode, ...CartBlockingCode[]],
  ): CartValidatedItemWithContextDto {
    return {
      productId: item.productId,
      variantId: item.variantId ?? null,
      productName: null,
      variantName: null,
      image: null,
      quantity: item.quantity,
      status: 'BLOCKED',
      blockingCodes,
      warnings: [...blockingCodes],
      unitPriceCents: null,
      lineTotalCents: null,
      availability: 'out_of_stock',
      priceHidden: false,
    };
  }

  /** F1.WU5d1 — sanitized blocked-row shape (same fields as not-found). */
  private excludedItem(
    warning: 'NOT_IN_CATALOG' | 'VARIANT_NOT_FOUND',
    productId: string,
    variantId: string | null,
    quantity: number,
  ): CartValidatedItem {
    return {
      productId,
      variantId,
      productName: '',
      variantName: null,
      image: null,
      quantity,
      unitPriceCents: null,
      lineTotalCents: null,
      availability: 'out_of_stock',
      priceHidden: false,
      warnings: [warning],
    };
  }

  private notFoundItem(
    productId: string,
    variantId: string | null,
    quantity: number,
  ): CartValidatedItem {
    return {
      productId,
      variantId,
      productName: '',
      variantName: null,
      image: null,
      quantity,
      unitPriceCents: null,
      lineTotalCents: null,
      availability: 'out_of_stock',
      priceHidden: false,
      warnings: ['NOT_FOUND'],
    };
  }
}
