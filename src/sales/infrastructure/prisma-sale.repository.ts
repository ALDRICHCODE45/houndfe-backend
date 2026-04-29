/**
 * PrismaSaleRepository - Infrastructure adapter for ISaleRepository.
 *
 * Implements persistence operations for Sales using Prisma ORM.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { ISaleRepository } from '../domain/sale.repository';
import { Sale } from '../domain/sale.entity';

@Injectable()
export class PrismaSaleRepository implements ISaleRepository {
  constructor(private readonly prisma: PrismaService) {}

  async save(sale: Sale): Promise<Sale> {
    // Check if sale exists
    const existing = await this.prisma.sale.findUnique({
      where: { id: sale.id },
    });

    // Delete existing items (we'll recreate them from domain state)
    await this.prisma.saleItem.deleteMany({
      where: { saleId: sale.id },
    });

    // Create or update sale
    const saleData = {
      status: sale.status,
    };

    if (!existing) {
      // Create new sale
      await this.prisma.sale.create({
        data: {
          id: sale.id,
          userId: sale.userId,
          ...saleData,
        },
      });
    } else {
      // Update existing sale
      await this.prisma.sale.update({
        where: { id: sale.id },
        data: saleData,
      });
    }

    // Create items
    if (sale.items.length > 0) {
      await this.prisma.saleItem.createMany({
        data: sale.items.map((item) => ({
          id: item.id,
          saleId: sale.id,
          productId: item.productId,
          variantId: item.variantId,
          productName: item.productName,
          variantName: item.variantName,
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
          unitPriceCurrency: item.unitPriceCurrency,
          originalPriceCents: item.originalPriceCents,
          priceSource:
            item.priceSource === 'default'
              ? 'DEFAULT'
              : item.priceSource === 'price_list'
                ? 'PRICE_LIST'
                : 'CUSTOM',
          appliedPriceListId: item.appliedPriceListId,
          customPriceCents: item.customPriceCents,
          discountType: item.discountType,
          discountValue: item.discountValue,
          discountAmountCents: item.discountAmountCents,
          prePriceCentsBeforeDiscount: item.prePriceCentsBeforeDiscount,
          discountTitle: item.discountTitle,
          discountedAt: item.discountedAt,
        })),
      });
    } else {
      // Explicitly handle empty items (for clearItems case)
      await this.prisma.saleItem.createMany({ data: [] });
    }

    // Reload and return
    return (await this.findById(sale.id))!;
  }

  async findById(id: string): Promise<Sale | null> {
    const saleData = await this.prisma.sale.findUnique({
      where: { id },
      include: { items: true },
    });

    if (!saleData) return null;

    return Sale.fromPersistence({
      id: saleData.id,
      userId: saleData.userId,
      status: saleData.status as 'DRAFT',
      items: saleData.items.map((item) => ({
        id: item.id,
        saleId: item.saleId,
        productId: item.productId,
        variantId: item.variantId,
        productName: item.productName,
        variantName: item.variantName,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
        unitPriceCurrency: item.unitPriceCurrency,
        originalPriceCents: item.originalPriceCents,
        priceSource: item.priceSource?.toLowerCase() as
          | 'default'
          | 'price_list'
          | 'custom'
          | undefined,
        appliedPriceListId: item.appliedPriceListId,
        customPriceCents: item.customPriceCents,
        discountType: item.discountType as 'amount' | 'percentage' | null,
        discountValue: item.discountValue,
        discountAmountCents: item.discountAmountCents,
        prePriceCentsBeforeDiscount: item.prePriceCentsBeforeDiscount,
        discountTitle: item.discountTitle,
        discountedAt: item.discountedAt,
      })),
      createdAt: saleData.createdAt,
      updatedAt: saleData.updatedAt,
    });
  }

  async findDraftsByUserId(userId: string): Promise<Sale[]> {
    const sales = await this.prisma.sale.findMany({
      where: {
        userId,
        status: 'DRAFT',
      },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });

    return sales.map((saleData) =>
      Sale.fromPersistence({
        id: saleData.id,
        userId: saleData.userId,
        status: saleData.status as 'DRAFT',
        items: saleData.items.map((item) => ({
          id: item.id,
          saleId: item.saleId,
          productId: item.productId,
          variantId: item.variantId,
          productName: item.productName,
          variantName: item.variantName,
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
          unitPriceCurrency: item.unitPriceCurrency,
          originalPriceCents: item.originalPriceCents,
          priceSource: item.priceSource?.toLowerCase() as
            | 'default'
            | 'price_list'
            | 'custom'
            | undefined,
          appliedPriceListId: item.appliedPriceListId,
          customPriceCents: item.customPriceCents,
          discountType: item.discountType as 'amount' | 'percentage' | null,
          discountValue: item.discountValue,
          discountAmountCents: item.discountAmountCents,
          prePriceCentsBeforeDiscount: item.prePriceCentsBeforeDiscount,
          discountTitle: item.discountTitle,
          discountedAt: item.discountedAt,
        })),
        createdAt: saleData.createdAt,
        updatedAt: saleData.updatedAt,
      }),
    );
  }

  async delete(id: string): Promise<void> {
    await this.prisma.sale.delete({
      where: { id },
    });
  }
}
