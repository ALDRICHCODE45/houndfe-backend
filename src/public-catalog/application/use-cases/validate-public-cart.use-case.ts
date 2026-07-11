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

    const productMap = new Map(
      (products as Array<Record<string, unknown>>).map((p: any) => [p.id, p]),
    );

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

      if (!product.includeInOnlineCatalog) {
        validatedItems.push({
          productId: item.productId,
          variantId: item.variantId ?? null,
          productName: product.name,
          variantName: null,
          image: product.images[0] ? { url: product.images[0].url } : null,
          quantity: item.quantity,
          unitPriceCents: null,
          lineTotalCents: null,
          availability: 'out_of_stock',
          priceHidden: false,
          warnings: ['NOT_IN_CATALOG'],
        });
        globalWarnings.add('NOT_IN_CATALOG');
        continue;
      }

      // Resolve variant if requested
      let variant: any = null;
      if (item.variantId) {
        variant = product.variants?.find((v: any) => v.id === item.variantId);
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
