import { Injectable } from '@nestjs/common';
import { ProductsService } from '../../products/products.service';

/**
 * Which price list actually produced a backorder's reference price.
 *
 * The bot pricing path (`SalesService.previewBotPricing`) quotes the customer's
 * price list and falls back to PUBLICO when that list has no price for the
 * product/variant. `referencePriceListId` records the customer's list only when
 * it really priced the line; a PUBLICO-fallback price is stored as `null`
 * (the column's "PUBLICO" meaning), never as a list that did not price it.
 */
@Injectable()
export class BackorderReferencePriceListResolver {
  constructor(private readonly products: ProductsService) {}

  async resolve(
    customerListId: string | null,
    line: { productId: string; variantId: string | null; quantity: number },
  ): Promise<string | null> {
    if (customerListId === null) return null;
    const prices = await this.products.batchResolvePriceMap([
      {
        productId: line.productId,
        variantId: line.variantId,
        quantity: line.quantity,
        priceListId: customerListId,
        globalPriceListId: customerListId,
      },
    ]);
    const key = `${line.productId}::${line.variantId ?? ''}::${customerListId}`;
    return prices.get(key)?.get(line.quantity) !== undefined
      ? customerListId
      : null;
  }
}
