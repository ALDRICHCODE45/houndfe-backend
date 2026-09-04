import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../../shared/prisma/tenant-prisma.service';
import type {
  CartValidationResponseDto,
  CartValidatedItem,
  CartWarningCode,
} from '../dto/cart-validation.dto';
import { mapStockStatus } from '../../domain/value-objects/stock-status.vo';
import { isEffectivelyPriceHidden } from '../../domain/value-objects/effective-price-hidden.vo';

interface CartInput {
  items: Array<{
    productId: string;
    variantId?: string;
    quantity: number;
  }>;
}

const BLOCKING_WARNINGS: CartWarningCode[] = [
  'NOT_FOUND',
  'NOT_IN_CATALOG',
  'VARIANT_NOT_FOUND',
  'OUT_OF_STOCK',
];

@Injectable()
export class ValidatePublicCartUseCase {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async execute(input: CartInput): Promise<CartValidationResponseDto> {
    const client = this.tenantPrisma.getClient();

    const productIds = [...new Set(input.items.map((i) => i.productId))];
    const variantIds = input.items
      .map((i) => i.variantId)
      .filter((id): id is string => id != null);

    const products = await client.product.findMany({
      where: { id: { in: productIds } },
      include: {
        priceLists: {
          where: { globalPriceList: { isDefault: true } },
          select: { priceCents: true },
          take: 1,
        },
        variants: {
          ...(variantIds.length > 0
            ? { where: { id: { in: variantIds } } }
            : {}),
          include: {
            variantPrices: {
              where: {
                priceList: { globalPriceList: { isDefault: true } },
              },
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

      if (priceHidden) {
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
        priceHidden,
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
