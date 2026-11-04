/**
 * ADAPTER: PrismaProductRepository
 *
 * Concrete implementation of IProductRepository using Prisma.
 * Translates between domain entities and database records.
 */
import { Inject, Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { Product } from '../domain/product.entity';
import type { IProductRepository } from '../domain/product.repository';
import {
  Prisma,
  ProductType,
  UnitOfMeasure,
  IvaRate,
  IepsRate,
  PurchaseCostMode,
  type Product as PrismaProduct,
} from '@prisma/client';
import {
  IStockAlertStateRepository,
  STOCK_ALERT_STATE_REPOSITORY,
} from '../../stock-alerts/domain/stock-alert-state.repository';

type RawCall = { sql: string };

/**
 * Relation payload — included on every product read so
 * `Product.fromPersistence` always has the optional 1:1 row and the
 * per-product catalog allowlist at hand. SERVICE rows always have a
 * serviceDetail; PRODUCT rows always have `serviceDetail: null`.
 */
const PRODUCT_WITH_SERVICE_DETAIL_INCLUDE = {
  serviceDetail: true,
  catalogPriceLists: { select: { globalPriceListId: true } },
} as const satisfies Prisma.ProductInclude;

type PrismaProductWithServiceDetail = Prisma.ProductGetPayload<{
  include: typeof PRODUCT_WITH_SERVICE_DETAIL_INCLUDE;
}>;

@Injectable()
export class PrismaProductRepository implements IProductRepository {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    @Inject(STOCK_ALERT_STATE_REPOSITORY)
    private readonly alertState: IStockAlertStateRepository,
  ) {}

  async findById(id: string): Promise<Product | null> {
    const prisma = this.tenantPrisma.getClient();
    const data = await prisma.product.findUnique({
      where: { id },
      include: PRODUCT_WITH_SERVICE_DETAIL_INCLUDE,
    });
    return data ? this.toDomain(data) : null;
  }

  async findBySku(sku: string): Promise<Product | null> {
    const prisma = this.tenantPrisma.getClient();
    const data = await prisma.product.findFirst({
      where: { sku: sku.toUpperCase() },
      include: PRODUCT_WITH_SERVICE_DETAIL_INCLUDE,
    });
    return data ? this.toDomain(data) : null;
  }

  async findByBarcode(barcode: string): Promise<Product | null> {
    const prisma = this.tenantPrisma.getClient();
    const data = await prisma.product.findFirst({
      where: { barcode },
      include: PRODUCT_WITH_SERVICE_DETAIL_INCLUDE,
    });
    return data ? this.toDomain(data) : null;
  }

  async findAll(): Promise<Product[]> {
    const prisma = this.tenantPrisma.getClient();
    const data = await prisma.product.findMany({
      orderBy: { createdAt: 'desc' },
      include: PRODUCT_WITH_SERVICE_DETAIL_INCLUDE,
    });
    return data.map((d) => this.toDomain(d));
  }

  async save(product: Product): Promise<Product> {
    // One transaction per save(): runInTransaction reuses the ambient
    // service-owned transaction instead of nesting, so the upsert,
    // allowlist replacement, and reload commit or roll back together.
    return this.tenantPrisma.runInTransaction(() =>
      this.saveInsideTransaction(product),
    );
  }

  private async saveInsideTransaction(product: Product): Promise<Product> {
    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.tenantPrisma.getTenantId();
    const p = product.toPersistence();
    const saved = await prisma.product.upsert({
      where: { id: p.id },
      update: {
        name: p.name,
        location: p.location,
        description: p.description,
        type: p.type as ProductType,
        sku: p.sku,
        barcode: p.barcode,
        unit: p.unit as UnitOfMeasure,
        satKey: p.satKey,
        categoryId: p.categoryId,
        brandId: p.brandId,
        sellInPos: p.sellInPos,
        includeInOnlineCatalog: p.includeInOnlineCatalog,
        requiresPrescription: p.requiresPrescription,
        chargeProductTaxes: p.chargeProductTaxes,
        ivaRate: p.ivaRate as IvaRate,
        iepsRate: p.iepsRate as IepsRate,
        purchaseCostMode: p.purchaseCostMode as PurchaseCostMode,
        purchaseNetCostCents: p.purchaseNetCostCents,
        purchaseGrossCostCents: p.purchaseGrossCostCents,
        useStock: p.useStock,
        useLotsAndExpirations: p.useLotsAndExpirations,
        // `quantity` is deliberately absent: stock only moves through the
        // inventory journal, so saving the aggregate never rewrites it (S2).
        minQuantity: p.minQuantity,
        hasVariants: p.hasVariants,
        hidePriceInOnlineCatalog: p.hidePriceInOnlineCatalog,
        onlineStockPresentation: p.onlineStockPresentation,
        onlineStockPresentationCustomQty: p.onlineStockPresentationCustomQty,
        updatedAt: new Date(),
      },
      create: {
        id: p.id,
        name: p.name,
        location: p.location,
        description: p.description,
        type: p.type as ProductType,
        sku: p.sku,
        barcode: p.barcode,
        unit: p.unit as UnitOfMeasure,
        satKey: p.satKey,
        categoryId: p.categoryId,
        brandId: p.brandId,
        sellInPos: p.sellInPos,
        includeInOnlineCatalog: p.includeInOnlineCatalog,
        requiresPrescription: p.requiresPrescription,
        chargeProductTaxes: p.chargeProductTaxes,
        ivaRate: p.ivaRate as IvaRate,
        iepsRate: p.iepsRate as IepsRate,
        purchaseCostMode: p.purchaseCostMode as PurchaseCostMode,
        purchaseNetCostCents: p.purchaseNetCostCents,
        purchaseGrossCostCents: p.purchaseGrossCostCents,
        useStock: p.useStock,
        useLotsAndExpirations: p.useLotsAndExpirations,
        quantity: p.quantity,
        minQuantity: p.minQuantity,
        hasVariants: p.hasVariants,
        hidePriceInOnlineCatalog: p.hidePriceInOnlineCatalog,
        onlineStockPresentation: p.onlineStockPresentation,
        onlineStockPresentationCustomQty: p.onlineStockPresentationCustomQty,
        tenantId,
      } as Prisma.ProductUncheckedCreateInput,
      include: PRODUCT_WITH_SERVICE_DETAIL_INCLUDE,
    });

    // Replace the per-product catalog allowlist on the same transaction
    // client as the upsert (zero IDs = zero rows; explicit tenantId +
    // productId predicates); a failure here escapes the boundary so the
    // transaction rolls back. The feature-detect tolerates only legacy
    // test doubles predating the join model.
    const joins = prisma.productCatalogPriceList;
    if (joins) {
      await joins.deleteMany({
        where: { tenantId, productId: p.id },
      });
      if (p.supportedCatalogPriceListIds.length > 0) {
        await joins.createMany({
          data: p.supportedCatalogPriceListIds.map((globalPriceListId) => ({
            tenantId,
            productId: p.id,
            globalPriceListId,
          })),
        });
      }
    }

    // The upsert snapshot predates the join replacement — reload so the
    // reconstructed aggregate reflects the persisted allowlist.
    const reloaded = await prisma.product.findUnique({
      where: { id: p.id },
      include: PRODUCT_WITH_SERVICE_DETAIL_INCLUDE,
    });
    return this.toDomain(reloaded ?? saved);
  }

  async delete(id: string): Promise<void> {
    const prisma = this.tenantPrisma.getClient();
    await prisma.product.delete({ where: { id } });
  }

  async isSkuTaken(
    sku: string,
    exclude?: { productId?: string; variantId?: string },
  ): Promise<boolean> {
    const upper = sku.toUpperCase();

    // Check products table — exclude the product being updated (if any)
    const prisma = this.tenantPrisma.getClient();
    const productMatch = await prisma.product.findFirst({
      where: {
        sku: upper,
        ...(exclude?.productId ? { id: { not: exclude.productId } } : {}),
      },
    });
    if (productMatch) return true;

    // Check variants table — exclude only the specific variant being updated (if any)
    const variantMatch = await prisma.variant.findFirst({
      where: {
        sku: upper,
        ...(exclude?.variantId ? { id: { not: exclude.variantId } } : {}),
      },
    });
    return !!variantMatch;
  }

  async isBarcodeTaken(
    barcode: string,
    exclude?: { productId?: string; variantId?: string },
  ): Promise<boolean> {
    // Check products table — exclude the product being updated (if any)
    const prisma = this.tenantPrisma.getClient();
    const productMatch = await prisma.product.findFirst({
      where: {
        barcode,
        ...(exclude?.productId ? { id: { not: exclude.productId } } : {}),
      },
    });
    if (productMatch) return true;

    // Check variants table — exclude only the specific variant being updated (if any)
    const variantMatch = await prisma.variant.findFirst({
      where: {
        barcode,
        ...(exclude?.variantId ? { id: { not: exclude.variantId } } : {}),
      },
    });
    return !!variantMatch;
  }

  /**
   * Edit-path re-arm. Asserts the ambient-tx guard and a STRICT `>` gate,
   * but does NOT touch the stock columns
   * itself — the edit write lives in the service layer. This method only
   * re-reads the RESULTING `(quantity, minQuantity)` inside the same
   * transaction (read-your-own-writes under READ COMMITTED) and, when
   * the boundary is crossed strictly upward, calls `alertState.rearm`
   * with the correct simple-vs-variant key.
   *
   * Two-branch SELECT:
   *   - product path: gates on `useStock = true` (parent column); a row
   *     missing that predicate returns 0 rows → early return (no rearm,
   *     no error — spec scenario: useStock = false).
   *   - variant path: SELECT must JOIN the parent `products` row to gate
   *     on the parent's `useStock` (Variant has no such column of its
   *     own). Non-stock parents are excluded by the JOIN, returning
   *     0 rows. The tenant-scoped join key preserves isolation.
   *
   * Spec coverage: stock-alerts/spec.md — "One-Shot Edge Trigger At Or
   * Below Min Quantity" (MODIFIED — edit-path re-arm scenarios).
   */
  async rearmAlertAfterEdit(item: {
    productId: string;
    variantId?: string | null;
  }): Promise<void> {
    // Mirror the restock ambient-tx guard. A partial commit (write
    // auto-committed, rearm never issued) would block the next alert
    // forever. Throw before touching the client.
    if (!this.tenantPrisma.isInTransaction()) {
      throw new Error(
        'rearmAlertAfterEdit must be called inside TenantPrismaService.runInTransaction',
      );
    }

    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.tenantPrisma.getTenantId();
    const { productId, variantId } = item;

    if (variantId) {
      // Variant path: JOIN products p to gate on the parent's
      // `useStock` (Variant has no such column). The tenant-scoped
      // join key (`p.tenantId = v.tenantId`) preserves isolation.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      const rows = (await prisma.$queryRaw`
        SELECT v."quantity"::int AS "q",
               v."minQuantity"::int AS "m"
          FROM "variants" v
          JOIN "products" p ON p."id" = v."productId"
                           AND p."tenantId" = v."tenantId"
         WHERE v."id" = ${variantId}
           AND v."productId" = ${productId}
           AND v."tenantId" = ${tenantId}
           AND p."useStock" = true
      `) as Array<{ q: number; m: number }>;

      if (rows.length !== 1) {
        // non-stock parent (JOIN excluded) OR row missing — no-op.
        return;
      }

      const { q, m } = rows[0];
      if (q > m) {
        await this.alertState.rearm({
          tx: prisma,
          tenantId,
          productId,
          variantId,
        });
      }
      return;
    }

    // Product path: tenant + useStock gate on the parent column. A
    // non-stock row returns 0 rows and the method short-circuits
    // without throwing (spec: useStock = false → no alert logic).
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const rows = (await prisma.$queryRaw`
      SELECT "quantity"::int AS "q",
             "minQuantity"::int AS "m"
        FROM "products"
       WHERE "id" = ${productId}
         AND "tenantId" = ${tenantId}
         AND "useStock" = true
    `) as Array<{ q: number; m: number }>;

    if (rows.length !== 1) {
      return;
    }

    const { q, m } = rows[0];
    if (q > m) {
      await this.alertState.rearm({
        tx: prisma,
        tenantId,
        productId,
        variantId: null,
      });
    }
  }

  private toDomain(data: PrismaProductWithServiceDetail): Product {
    return Product.fromPersistence({
      id: data.id,
      name: data.name,
      location: data.location,
      description: data.description,
      type: data.type,
      sku: data.sku,
      barcode: data.barcode,
      unit: data.unit,
      satKey: data.satKey,
      categoryId: data.categoryId,
      brandId: data.brandId,
      sellInPos: data.sellInPos,
      includeInOnlineCatalog: data.includeInOnlineCatalog,
      requiresPrescription: data.requiresPrescription,
      chargeProductTaxes: data.chargeProductTaxes,
      ivaRate: data.ivaRate,
      iepsRate: data.iepsRate,
      purchaseCostMode: data.purchaseCostMode,
      purchaseNetCostCents: data.purchaseNetCostCents,
      purchaseGrossCostCents: data.purchaseGrossCostCents,
      useStock: data.useStock,
      useLotsAndExpirations: data.useLotsAndExpirations,
      quantity: data.quantity,
      minQuantity: data.minQuantity,
      hasVariants: data.hasVariants,
      hidePriceInOnlineCatalog: data.hidePriceInOnlineCatalog,
      onlineStockPresentation: data.onlineStockPresentation,
      onlineStockPresentationCustomQty: data.onlineStockPresentationCustomQty,
      supportedCatalogPriceListIds: (data.catalogPriceLists ?? []).map(
        (binding) => binding.globalPriceListId,
      ),
      serviceDetail: data.serviceDetail
        ? {
            id: data.serviceDetail.id,
            productId: data.serviceDetail.productId,
            capacity: data.serviceDetail.capacity,
            notes: data.serviceDetail.notes,
          }
        : null,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    });
  }
}
