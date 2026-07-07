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
import { OutboxWriterService } from '../../shared/outbox/outbox-writer.service';
import {
  IStockAlertStateRepository,
  STOCK_ALERT_STATE_REPOSITORY,
} from '../../stock-alerts/domain/stock-alert-state.repository';
import type { StockCrossing } from '../../stock-alerts/domain/stock-crossing';

type RawCall = { sql: string };
type TxClient = {
  $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
  // OutboxWriterService.publish expects Prisma.TransactionClient; the
  // tenant-scoped client (and the tx client it surfaces inside
  // `runInTransaction`) is structurally compatible but not nominally,
  // so we cast through `unknown`.
  [key: string]: unknown;
};

@Injectable()
export class PrismaProductRepository implements IProductRepository {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly outbox: OutboxWriterService,
    @Inject(STOCK_ALERT_STATE_REPOSITORY)
    private readonly alertState: IStockAlertStateRepository,
  ) {}

  async findById(id: string): Promise<Product | null> {
    const prisma = this.tenantPrisma.getClient();
    const data = await prisma.product.findUnique({ where: { id } });
    return data ? this.toDomain(data) : null;
  }

  async findBySku(sku: string): Promise<Product | null> {
    const prisma = this.tenantPrisma.getClient();
    const data = await prisma.product.findFirst({
      where: { sku: sku.toUpperCase() },
    });
    return data ? this.toDomain(data) : null;
  }

  async findByBarcode(barcode: string): Promise<Product | null> {
    const prisma = this.tenantPrisma.getClient();
    const data = await prisma.product.findFirst({
      where: { barcode },
    });
    return data ? this.toDomain(data) : null;
  }

  async findAll(): Promise<Product[]> {
    const prisma = this.tenantPrisma.getClient();
    const data = await prisma.product.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return data.map((d) => this.toDomain(d));
  }

  async save(product: Product): Promise<Product> {
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
        quantity: p.quantity,
        minQuantity: p.minQuantity,
        hasVariants: p.hasVariants,
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
        tenantId,
      } as Prisma.ProductUncheckedCreateInput,
    });
    return this.toDomain(saved);
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
   * Slice E.2 — Stock Decrement Returns Threshold Crossings.
   *
   * Each adjustment runs ONE raw `UPDATE ... RETURNING` to atomically
   * decrement and read back the new quantity + minQuantity. The PRE-gate
   * (`pre > minQuantity && newQty <= minQuantity && !useLotsAndExpirations`)
   * decides whether to invoke the alert-state flip + outbox write.
   *
   * For products: a zero-row UPDATE falls through to a `SELECT` that
   * disambiguates a non-stock row (`useStock = false`) from a true
   * insufficient-stock error.
   *
   * For variants: zero rows ⇒ throw (no non-stock fallback for variants).
   *
   * Return value (spec sales/spec.md §"Stock Decrement Returns Threshold
   * Crossings"): the array contains ONLY items that crossed downward
   * AND won the flip. Items that did not cross, that crossed but lost
   * the flip to a concurrent tx, that are lots/expiration products,
   * and that were already alerted prior to this transaction MUST NOT
   * appear in the returned array.
   */
  async decrementStockForCharge(
    adjustments: Array<{
      productId: string;
      variantId?: string | null;
      quantity: number;
    }>,
  ): Promise<StockCrossing[]> {
    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.tenantPrisma.getTenantId();
    const crossings: StockCrossing[] = [];

    for (const adjustment of adjustments) {
      if (adjustment.quantity <= 0) continue;

      if (adjustment.variantId) {
        // Variant path: no useStock / useLotsAndExpirations columns on
        // the variants table (design Decision 5, finding #9).
        const variantRows = (await prisma.$queryRaw`
          UPDATE "variants"
             SET "quantity" = "quantity" - ${adjustment.quantity},
                 "updatedAt" = NOW()
           WHERE "id" = ${adjustment.variantId}
             AND "productId" = ${adjustment.productId}
             AND "tenantId" = ${tenantId}
             AND "quantity" >= ${adjustment.quantity}
          RETURNING "quantity"::int AS "newQuantity",
                    "minQuantity"::int AS "minQuantity"
        `) as Array<{ newQuantity: number; minQuantity: number }>;

        if (variantRows.length !== 1) {
          throw new Error('STOCK_INSUFFICIENT_AT_CONFIRM');
        }

        const { newQuantity, minQuantity } = variantRows[0];
        const pre = newQuantity + adjustment.quantity;

        // PRE-gate: variant products are inherently lots-free
        // (variant-bearing products cannot use lots — design Decision 5,
        // schema:352).
        if (pre > minQuantity && newQuantity <= minQuantity) {
          const won = await this.flipAndOutbox(prisma, tenantId, {
            productId: adjustment.productId,
            variantId: adjustment.variantId,
            newQuantity,
            minQuantity,
          });
          if (won) {
            crossings.push({
              productId: adjustment.productId,
              variantId: adjustment.variantId,
              newQuantity,
              minQuantity,
            });
          }
        }
        continue;
      }

      // Product path: tenant + useStock guard + quantity guard.
      const productRows = (await prisma.$queryRaw`
        UPDATE "products"
           SET "quantity" = "quantity" - ${adjustment.quantity},
               "updatedAt" = NOW()
         WHERE "id" = ${adjustment.productId}
           AND "tenantId" = ${tenantId}
           AND "useStock" = true
           AND "quantity" >= ${adjustment.quantity}
        RETURNING "quantity"::int AS "newQuantity",
                  "minQuantity"::int AS "minQuantity",
                  "useLotsAndExpirations" AS "useLotsAndExpirations"
      `) as Array<{
        newQuantity: number;
        minQuantity: number;
        useLotsAndExpirations: boolean;
      }>;

      if (productRows.length !== 1) {
        // Non-stock fallback: skip silently if `useStock=false`.
        const nonStock = (await prisma.$queryRaw`
          SELECT "id"::text AS "id"
            FROM "products"
           WHERE "id" = ${adjustment.productId}
             AND "tenantId" = ${tenantId}
             AND "useStock" = false
        `) as Array<{ id: string }>;

        if (nonStock.length > 0) {
          continue;
        }
        throw new Error('STOCK_INSUFFICIENT_AT_CONFIRM');
      }

      const { newQuantity, minQuantity, useLotsAndExpirations } = productRows[0];
      const pre = newQuantity + adjustment.quantity;

      // PRE-gate: pre > minQty && newQty <= minQty && !useLotsAndExpirations.
      if (
        pre > minQuantity &&
        newQuantity <= minQuantity &&
        !useLotsAndExpirations
      ) {
        const won = await this.flipAndOutbox(prisma, tenantId, {
          productId: adjustment.productId,
          variantId: null,
          newQuantity,
          minQuantity,
        });
        if (won) {
          crossings.push({
            productId: adjustment.productId,
            variantId: null,
            newQuantity,
            minQuantity,
          });
        }
      }
    }

    return crossings;
  }

  /**
   * Slice E.2 — atomic flip + outbox write (in the SAME transaction as
   * the decrement). Called only when the PRE-gate fires. The flip is
   * the conditional `UPDATE ... RETURNING "alertEpoch"`; if the flip
   * LOSES (a concurrent tx already flipped the same key) we MUST NOT
   * write to the outbox — the winning tx owns this crossing.
   *
   * Returns `true` when THIS transaction owns the crossing (flip won
   * AND outbox row written). Returns `false` when the flip lost (the
   * caller MUST omit this item from the returned crossings array).
   */
  private async flipAndOutbox(
    tx: TxClient,
    tenantId: string,
    crossing: StockCrossing,
  ): Promise<boolean> {
    const alertEpoch = await this.alertState.seedAndFlip({
      tx,
      tenantId,
      productId: crossing.productId,
      variantId: crossing.variantId,
    });

    if (alertEpoch === null) {
      // Another tx owns the crossing — no outbox row from us.
      return false;
    }

    const variantKey = crossing.variantId ?? '__PRODUCT__';
    const aggregateId = `${crossing.productId}:${variantKey}`;

    await this.outbox.publish(
      // The tenant-scoped Prisma client (or its tx surrogate inside
      // `runInTransaction`) is structurally compatible with
      // `Prisma.TransactionClient` but not nominally; cast through
      // `unknown` to satisfy the strict outbox API.
      tx as unknown as Parameters<OutboxWriterService['publish']>[0],
      tenantId,
      'StockAlert',
      aggregateId,
      'stock.low.detected',
      {
        tenantId,
        productId: crossing.productId,
        variantId: crossing.variantId,
        variantKey,
        alertEpoch,
        newQuantity: crossing.newQuantity,
        minQuantity: crossing.minQuantity,
        // Enrichment (productName, variantDescription, sku, category,
        // deepLink) is added by the Slice F dispatcher right before
        // InngestService.send — we keep this row minimal in-tx so the
        // hot path stays cheap (design Risk R-C).
        productName: '',
        variantDescription: null,
        sku: null,
        category: null,
        deepLink: '',
        occurredAt: new Date().toISOString(),
      },
    );

    return true;
  }

  /**
   * Slice E.2 — re-arm on restock, with STRICT `newQuantity > minQuantity`
   * precondition (design Decision 6). The `stock_alert_states` row stays
   * (alertEpoch preserved); only `alerted` flips back to false.
   */
  async incrementStockForRestock(
    adjustments: Array<{
      productId: string;
      variantId?: string | null;
      quantity: number;
    }>,
  ): Promise<void> {
    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.tenantPrisma.getTenantId();

    for (const adjustment of adjustments) {
      if (adjustment.quantity <= 0) continue;

      if (adjustment.variantId) {
        const variantRows = (await prisma.$queryRaw`
          UPDATE "variants"
             SET "quantity" = "quantity" + ${adjustment.quantity},
                 "updatedAt" = NOW()
           WHERE "id" = ${adjustment.variantId}
             AND "productId" = ${adjustment.productId}
             AND "tenantId" = ${tenantId}
          RETURNING "quantity"::int AS "newQuantity",
                    "minQuantity"::int AS "minQuantity"
        `) as Array<{ newQuantity: number; minQuantity: number }>;

        if (variantRows.length !== 1) continue;

        const { newQuantity, minQuantity } = variantRows[0];
        if (newQuantity > minQuantity) {
          await this.alertState.rearm({
            tx: prisma,
            tenantId,
            productId: adjustment.productId,
            variantId: adjustment.variantId,
          });
        }
        continue;
      }

      const productRows = (await prisma.$queryRaw`
        UPDATE "products"
           SET "quantity" = "quantity" + ${adjustment.quantity},
               "updatedAt" = NOW()
         WHERE "id" = ${adjustment.productId}
           AND "tenantId" = ${tenantId}
           AND "useStock" = true
        RETURNING "quantity"::int AS "newQuantity",
                  "minQuantity"::int AS "minQuantity"
      `) as Array<{ newQuantity: number; minQuantity: number }>;

      if (productRows.length !== 1) continue;

      const { newQuantity, minQuantity } = productRows[0];
      if (newQuantity > minQuantity) {
        await this.alertState.rearm({
          tx: prisma,
          tenantId,
          productId: adjustment.productId,
          variantId: null,
        });
      }
    }
  }

  private toDomain(data: PrismaProduct): Product {
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
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    });
  }
}