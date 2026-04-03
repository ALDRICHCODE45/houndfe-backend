import { Injectable } from '@nestjs/common';
import { PrismaService } from '../shared/prisma/prisma.service';
import {
  BusinessRuleViolationError,
  EntityAlreadyExistsError,
  EntityNotFoundError,
  InvalidArgumentError,
} from '../shared/domain/domain-error';
import { CreatePriceListDto } from './dto/create-price-list.dto';
import { UpdatePriceListDto } from './dto/update-price-list.dto';

@Injectable()
export class PriceListsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    return this.prisma.globalPriceList.findMany({
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
  }

  async create(dto: CreatePriceListDto) {
    const name = dto.name.trim();
    if (!name) {
      throw new InvalidArgumentError('Price list name cannot be empty');
    }

    const existing = await this.prisma.globalPriceList.findUnique({
      where: { name },
      select: { id: true },
    });
    if (existing) {
      throw new EntityAlreadyExistsError('GlobalPriceList', name);
    }

    return this.prisma.$transaction(async (tx) => {
      const createdGlobalList = await tx.globalPriceList.create({
        data: { name },
      });

      const products = await tx.product.findMany({
        select: { id: true, hasVariants: true },
      });

      if (products.length) {
        await tx.priceList.createMany({
          data: products.map((product) => ({
            productId: product.id,
            globalPriceListId: createdGlobalList.id,
            priceCents: 0,
          })),
        });

        const productsWithVariants = products
          .filter((product) => product.hasVariants)
          .map((product) => product.id);

        if (productsWithVariants.length) {
          const variants = await tx.variant.findMany({
            where: { productId: { in: productsWithVariants } },
            select: { id: true, productId: true },
          });

          if (variants.length) {
            const priceLists = await tx.priceList.findMany({
              where: {
                productId: { in: productsWithVariants },
                globalPriceListId: createdGlobalList.id,
              },
              select: { id: true, productId: true },
            });

            const priceListByProductId = new Map(
              priceLists.map((priceList) => [
                priceList.productId,
                priceList.id,
              ]),
            );

            const variantPricesData = variants
              .map((variant) => {
                const priceListId = priceListByProductId.get(variant.productId);
                if (!priceListId) return null;

                return {
                  variantId: variant.id,
                  priceListId,
                  priceCents: 0,
                };
              })
              .filter(
                (item): item is NonNullable<typeof item> => item !== null,
              );

            if (variantPricesData.length) {
              await tx.variantPrice.createMany({ data: variantPricesData });
            }
          }
        }
      }

      return createdGlobalList;
    });
  }

  async update(id: string, dto: UpdatePriceListDto) {
    const globalPriceList = await this.prisma.globalPriceList.findUnique({
      where: { id },
      select: { id: true, isDefault: true },
    });
    if (!globalPriceList) {
      throw new EntityNotFoundError('GlobalPriceList', id);
    }

    if (globalPriceList.isDefault) {
      throw new BusinessRuleViolationError(
        'Cannot rename the default PUBLICO price list',
        'DEFAULT_PRICE_LIST_PROTECTED',
      );
    }

    const name = dto.name?.trim();
    if (name !== undefined && !name) {
      throw new InvalidArgumentError('Price list name cannot be empty');
    }

    if (name) {
      const duplicate = await this.prisma.globalPriceList.findUnique({
        where: { name },
        select: { id: true },
      });

      if (duplicate && duplicate.id !== id) {
        throw new EntityAlreadyExistsError('GlobalPriceList', name);
      }
    }

    return this.prisma.globalPriceList.update({
      where: { id },
      data: {
        ...(name ? { name } : {}),
      },
    });
  }

  async remove(id: string): Promise<void> {
    const globalPriceList = await this.prisma.globalPriceList.findUnique({
      where: { id },
      select: { id: true, isDefault: true },
    });
    if (!globalPriceList) {
      throw new EntityNotFoundError('GlobalPriceList', id);
    }

    if (globalPriceList.isDefault) {
      throw new BusinessRuleViolationError(
        'Cannot delete the default PUBLICO price list',
        'DEFAULT_PRICE_LIST_PROTECTED',
      );
    }

    await this.prisma.globalPriceList.delete({ where: { id } });
  }
}
