/**
 * ADAPTER: PrismaProductRepository
 *
 * Concrete implementation of IProductRepository using Prisma.
 * Translates between domain entities and database records.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { Product } from '../domain/product.entity';
import type { IProductRepository } from '../domain/product.repository';
import type { Product as PrismaProduct } from '@prisma/client';

@Injectable()
export class PrismaProductRepository implements IProductRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<Product | null> {
    const data = await this.prisma.product.findUnique({ where: { id } });
    return data ? this.toDomain(data) : null;
  }

  async findBySku(sku: string): Promise<Product | null> {
    const data = await this.prisma.product.findUnique({
      where: { sku: sku.toUpperCase() },
    });
    return data ? this.toDomain(data) : null;
  }

  async findByBarcode(barcode: string): Promise<Product | null> {
    const data = await this.prisma.product.findUnique({
      where: { barcode },
    });
    return data ? this.toDomain(data) : null;
  }

  async findAll(): Promise<Product[]> {
    const data = await this.prisma.product.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return data.map((d) => this.toDomain(d));
  }

  async save(product: Product): Promise<Product> {
    const p = product.toPersistence();
    const saved = await this.prisma.product.upsert({
      where: { id: p.id },
      update: {
        name: p.name,
        location: p.location,
        description: p.description,
        type: p.type as any,
        sku: p.sku,
        barcode: p.barcode,
        unit: p.unit as any,
        satKey: p.satKey,
        categoryId: p.categoryId,
        sellInPos: p.sellInPos,
        includeInOnlineCatalog: p.includeInOnlineCatalog,
        chargeProductTaxes: p.chargeProductTaxes,
        ivaRate: p.ivaRate as any,
        iepsRate: p.iepsRate as any,
        purchaseCostMode: p.purchaseCostMode as any,
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
        type: p.type as any,
        sku: p.sku,
        barcode: p.barcode,
        unit: p.unit as any,
        satKey: p.satKey,
        categoryId: p.categoryId,
        sellInPos: p.sellInPos,
        includeInOnlineCatalog: p.includeInOnlineCatalog,
        chargeProductTaxes: p.chargeProductTaxes,
        ivaRate: p.ivaRate as any,
        iepsRate: p.iepsRate as any,
        purchaseCostMode: p.purchaseCostMode as any,
        purchaseNetCostCents: p.purchaseNetCostCents,
        purchaseGrossCostCents: p.purchaseGrossCostCents,
        useStock: p.useStock,
        useLotsAndExpirations: p.useLotsAndExpirations,
        quantity: p.quantity,
        minQuantity: p.minQuantity,
        hasVariants: p.hasVariants,
      },
    });
    return this.toDomain(saved);
  }

  async delete(id: string): Promise<void> {
    await this.prisma.product.delete({ where: { id } });
  }

  async isSkuTaken(
    sku: string,
    exclude?: { productId?: string; variantId?: string },
  ): Promise<boolean> {
    const upper = sku.toUpperCase();

    // Check products table — exclude the product being updated (if any)
    const productMatch = await this.prisma.product.findFirst({
      where: {
        sku: upper,
        ...(exclude?.productId ? { id: { not: exclude.productId } } : {}),
      },
    });
    if (productMatch) return true;

    // Check variants table — exclude only the specific variant being updated (if any)
    const variantMatch = await this.prisma.variant.findFirst({
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
    const productMatch = await this.prisma.product.findFirst({
      where: {
        barcode,
        ...(exclude?.productId ? { id: { not: exclude.productId } } : {}),
      },
    });
    if (productMatch) return true;

    // Check variants table — exclude only the specific variant being updated (if any)
    const variantMatch = await this.prisma.variant.findFirst({
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
      sellInPos: data.sellInPos,
      includeInOnlineCatalog: data.includeInOnlineCatalog,
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
