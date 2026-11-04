import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { businessToday } from '../domain/fefo-allocator';
import type { StockSnapshot } from './inventory-contract';
import { buildStockSnapshot } from './inventory-views';

/** Reads the stock contract inside the caller's ambient transaction. */
@Injectable()
export class InventoryStockReader {
  private readonly businessTimezone: string;

  constructor(
    private readonly db: TenantPrismaService,
    config: ConfigService,
  ) {
    this.businessTimezone = config.get<string>(
      'PROMOTIONS_BUSINESS_TIMEZONE',
      'America/Mexico_City',
    );
  }

  /** `null` when the product does not exist in the tenant. */
  async read(
    tenantId: string,
    productId: string,
    now: Date = new Date(),
  ): Promise<StockSnapshot | null> {
    const db = this.db.getClient();
    // Journal writers lock the product row FOR UPDATE before touching its
    // buckets; holding it FOR SHARE first keeps product, lots and variants
    // from changing between the reads below (one consistent snapshot).
    await db.$queryRaw`SELECT 1 FROM "products"
      WHERE "id" = ${productId} AND "tenantId" = ${tenantId} FOR SHARE`;
    const product = await db.product.findFirst({
      where: { id: productId, tenantId },
      select: {
        id: true,
        name: true,
        type: true,
        useStock: true,
        hasVariants: true,
        quantity: true,
        stockVersion: true,
      },
    });
    if (!product) return null;
    const [lots, variants] = await Promise.all([
      db.lot.findMany({
        where: { productId, tenantId },
        select: {
          id: true,
          lotNumber: true,
          quantity: true,
          stockVersion: true,
          expirationDate: true,
        },
      }),
      db.variant.findMany({
        where: { productId, tenantId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, name: true, quantity: true, stockVersion: true },
      }),
    ]);
    return buildStockSnapshot(
      { product, lots, variants },
      businessToday(now, this.businessTimezone),
    );
  }
}
