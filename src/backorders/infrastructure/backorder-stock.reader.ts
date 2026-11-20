import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sellableQuantity } from '../../chatbot-api/application/chatbot-api.service';
import {
  businessToday,
  sumExpiredLotQuantity,
} from '../../inventory/domain/fefo-allocator';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';

/**
 * Sellable stock of one product/variant, computed exactly like the bot
 * catalog (`ChatbotApiService.deriveProductStock` + `expiredLotQuantities`) so
 * `STOCK_AVAILABLE_NOW` agrees with what the bot just told the customer:
 *
 * - a variant line: the variant's own `quantity`, never below 0;
 * - a product without variants: `quantity` minus the units in expired lots
 *   (an expired lot is never sellable), never below 0;
 * - a product that does not track stock: `null` (always sellable).
 *
 * Units reserved for a backorder are journaled out of `quantity` (contract §3),
 * so this figure already excludes them once they exist.
 */
@Injectable()
export class BackorderStockReader {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly config: ConfigService,
  ) {}

  async sellable(
    product: { id: string; useStock: boolean; quantity: number },
    variant: { quantity: number } | null,
  ): Promise<number | null> {
    if (!product.useStock) return null;
    if (variant) return Math.max(variant.quantity, 0);
    const lots = await this.tenantPrisma.getClient().lot.findMany({
      where: {
        tenantId: this.tenantPrisma.getTenantId(),
        productId: product.id,
        quantity: { gt: 0 },
      },
      select: { quantity: true, expirationDate: true },
    });
    const today = businessToday(
      new Date(),
      this.config.get<string>('PROMOTIONS_BUSINESS_TIMEZONE') ??
        'America/Mexico_City',
    );
    return sellableQuantity(
      product.quantity,
      sumExpiredLotQuantity(lots, today),
    );
  }
}
