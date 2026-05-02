/**
 * ADAPTER: PrismaProductRepository
 *
 * Concrete implementation of IProductRepository using Prisma.
 * Translates between domain entities and database records.
 */
import { Injectable } from '@nestjs/common';
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

@Injectable()
export class PrismaProductRepository implements IProductRepository {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

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
