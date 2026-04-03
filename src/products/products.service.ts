/**
 * ProductsService - Application layer (Use Cases).
 *
 * Orchestrates domain logic and infrastructure for the Product aggregate.
 * Handles: Product CRUD, Variants, Lots, PriceLists, TierPrices, Images.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Product } from './domain/product.entity';
import type { IProductRepository } from './domain/product.repository';
import { PRODUCT_REPOSITORY } from './domain/product.repository';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { CreateVariantDto, UpdateVariantDto } from './dto/variant.dto';
import { CreateLotDto, UpdateLotDto } from './dto/lot.dto';
import { UpdatePriceListDto } from './dto/price-list.dto';
import { CreateImageDto } from './dto/image.dto';
import {
  BulkUpsertVariantPricesDto,
  UpsertVariantPriceDto,
} from './dto/variant-price.dto';
import {
  EntityNotFoundError,
  EntityAlreadyExistsError,
  BusinessRuleViolationError,
  InvalidArgumentError,
} from '../shared/domain/domain-error';
import { PrismaService } from '../shared/prisma/prisma.service';
import type { IvaRateValue } from './domain/value-objects/iva-rate.value-object';
import type { IepsRateValue } from './domain/value-objects/ieps-rate.value-object';
import type { PurchaseCostModeValue } from './domain/value-objects/purchase-cost.value-object';
import type { ProductType, UnitOfMeasure } from './domain/product.entity';
import { Prisma } from '@prisma/client';

@Injectable()
export class ProductsService {
  constructor(
    @Inject(PRODUCT_REPOSITORY)
    private readonly productRepo: IProductRepository,
    private readonly prisma: PrismaService,
  ) {}

  // ==================== Product CRUD ====================

  async create(dto: CreateProductDto) {
    // SKU uniqueness
    if (dto.sku) {
      const taken = await this.productRepo.isSkuTaken(dto.sku);
      if (taken) throw new EntityAlreadyExistsError('SKU', dto.sku);
    }

    // Barcode uniqueness
    if (dto.barcode) {
      const taken = await this.productRepo.isBarcodeTaken(dto.barcode);
      if (taken) throw new EntityAlreadyExistsError('Barcode', dto.barcode);
    }

    const product = Product.create({
      id: crypto.randomUUID(),
      name: dto.name,
      location: dto.location,
      description: dto.description,
      type: (dto.type as ProductType) ?? undefined,
      sku: dto.sku,
      barcode: dto.barcode,
      unit: (dto.unit as UnitOfMeasure) ?? undefined,
      satKey: dto.satKey,
      categoryId: dto.categoryId,
      sellInPos: dto.sellInPos,
      includeInOnlineCatalog: dto.includeInOnlineCatalog,
      requiresPrescription: dto.requiresPrescription,
      chargeProductTaxes: dto.chargeProductTaxes,
      ivaRate: dto.ivaRate as IvaRateValue | undefined,
      iepsRate: dto.iepsRate as IepsRateValue | undefined,
      purchaseCostMode: dto.purchaseCost?.mode as
        | PurchaseCostModeValue
        | undefined,
      purchaseCostValue: dto.purchaseCost?.valueCents,
      useStock: dto.useStock,
      useLotsAndExpirations: dto.useLotsAndExpirations,
      quantity: dto.quantity,
      minQuantity: dto.minQuantity,
      hasVariants: dto.hasVariants,
    });

    const saved = await this.productRepo.save(product);

    const globalLists = await this.prisma.globalPriceList.findMany({
      select: { id: true, isDefault: true },
    });

    if (globalLists.length) {
      await this.prisma.priceList.createMany({
        data: globalLists.map((globalList) => ({
          productId: saved.id,
          globalPriceListId: globalList.id,
          priceCents: globalList.isDefault ? (dto.priceCents ?? 0) : 0,
        })),
      });
    }

    return this.buildFullResponse(saved.id);
  }

  async findAll() {
    const products = await this.prisma.product.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { variants: true } },
        variants: { select: { quantity: true } },
        priceLists: {
          where: { globalPriceList: { isDefault: true } },
          select: { priceCents: true },
          take: 1,
        },
      },
    });

    return products.map((product) => {
      const baseResponse = Product.fromPersistence({
        id: product.id,
        name: product.name,
        location: product.location,
        description: product.description,
        type: product.type,
        sku: product.sku,
        barcode: product.barcode,
        unit: product.unit,
        satKey: product.satKey,
        categoryId: product.categoryId,
        sellInPos: product.sellInPos,
        includeInOnlineCatalog: product.includeInOnlineCatalog,
        requiresPrescription: product.requiresPrescription,
        chargeProductTaxes: product.chargeProductTaxes,
        ivaRate: product.ivaRate,
        iepsRate: product.iepsRate,
        purchaseCostMode: product.purchaseCostMode,
        purchaseNetCostCents: product.purchaseNetCostCents,
        purchaseGrossCostCents: product.purchaseGrossCostCents,
        useStock: product.useStock,
        useLotsAndExpirations: product.useLotsAndExpirations,
        quantity: product.quantity,
        minQuantity: product.minQuantity,
        hasVariants: product.hasVariants,
        createdAt: product.createdAt,
        updatedAt: product.updatedAt,
      }).toResponse();

      const publicoPriceCents = product.priceLists?.[0]?.priceCents ?? 0;
      const responseWithPublicPrice = {
        ...baseResponse,
        priceCents: publicoPriceCents,
        priceDecimal: publicoPriceCents / 100,
      };

      if (!responseWithPublicPrice.hasVariants) {
        return responseWithPublicPrice;
      }

      const variantStockTotal = product.variants.reduce(
        (total, variant) => total + variant.quantity,
        0,
      );

      return {
        ...responseWithPublicPrice,
        variantStockTotal,
        variantCount: product._count.variants,
      };
    });
  }

  async findOne(id: string) {
    return this.buildFullResponse(id);
  }

  async update(id: string, dto: UpdateProductDto) {
    const product = await this.productRepo.findById(id);
    if (!product) throw new EntityNotFoundError('Product', id);
    const previousUseStock = product.useStock;

    // SKU uniqueness check — exclude this product only
    if (dto.sku !== undefined && dto.sku !== null) {
      const taken = await this.productRepo.isSkuTaken(dto.sku, {
        productId: id,
      });
      if (taken) throw new EntityAlreadyExistsError('SKU', dto.sku);
      product.sku = dto.sku.trim().toUpperCase() || null;
    }

    // Barcode uniqueness check — exclude this product only
    if (dto.barcode !== undefined && dto.barcode !== null) {
      const taken = await this.productRepo.isBarcodeTaken(dto.barcode, {
        productId: id,
      });
      if (taken) throw new EntityAlreadyExistsError('Barcode', dto.barcode);
      product.barcode = dto.barcode.trim() || null;
    }

    if (dto.name !== undefined) product.updateName(dto.name);
    if (dto.location !== undefined)
      product.location = dto.location?.trim() || null;
    if (dto.description !== undefined)
      product.description = dto.description?.trim() || null;
    if (dto.type !== undefined) product.type = dto.type as ProductType;
    if (dto.unit !== undefined) product.unit = dto.unit as UnitOfMeasure;
    if (dto.satKey !== undefined) product.satKey = dto.satKey || null;
    if (dto.categoryId !== undefined)
      product.categoryId = dto.categoryId || null;
    if (dto.sellInPos !== undefined) product.sellInPos = dto.sellInPos;
    if (dto.includeInOnlineCatalog !== undefined)
      product.includeInOnlineCatalog = dto.includeInOnlineCatalog;
    if (dto.requiresPrescription !== undefined)
      product.requiresPrescription = dto.requiresPrescription;
    if (dto.chargeProductTaxes !== undefined)
      product.chargeProductTaxes = dto.chargeProductTaxes;
    if (dto.useStock !== undefined) product.useStock = dto.useStock;
    if (dto.useLotsAndExpirations !== undefined)
      product.useLotsAndExpirations = dto.useLotsAndExpirations;
    if (dto.quantity !== undefined) product.quantity = dto.quantity;
    if (dto.minQuantity !== undefined) product.minQuantity = dto.minQuantity;
    if (dto.hasVariants !== undefined) product.hasVariants = dto.hasVariants;

    product.normalizeStockConfiguration();

    // Taxes — recalculate purchase cost if taxes or cost changed
    if (dto.ivaRate !== undefined) {
      const { IvaRate } =
        await import('./domain/value-objects/iva-rate.value-object');
      product.ivaRate = IvaRate.create(dto.ivaRate);
    }
    if (dto.iepsRate !== undefined) {
      const { IepsRate } =
        await import('./domain/value-objects/ieps-rate.value-object');
      product.iepsRate = IepsRate.create(dto.iepsRate);
    }
    if (dto.purchaseCost) {
      const { PurchaseCost } =
        await import('./domain/value-objects/purchase-cost.value-object');
      product.purchaseCost = PurchaseCost.create(
        dto.purchaseCost.mode,
        dto.purchaseCost.valueCents,
        product.ivaRate.multiplier,
        product.iepsRate.multiplier,
      );
    }

    // Update default price list if priceCents provided
    if (dto.priceCents !== undefined) {
      const defaultGlobalList = await this.prisma.globalPriceList.findFirst({
        where: { isDefault: true },
        select: { id: true },
      });

      if (defaultGlobalList) {
        await this.prisma.priceList.updateMany({
          where: {
            productId: id,
            globalPriceListId: defaultGlobalList.id,
          },
          data: { priceCents: dto.priceCents },
        });
      }
    }

    product.updatedAt = new Date();
    await this.productRepo.save(product);

    if (dto.useStock === false && previousUseStock !== false) {
      await this.prisma.variant.updateMany({
        where: { productId: id },
        data: { minQuantity: 0 },
      });
    }

    return this.buildFullResponse(id);
  }

  async remove(id: string): Promise<void> {
    const product = await this.productRepo.findById(id);
    if (!product) throw new EntityNotFoundError('Product', id);
    await this.productRepo.delete(id);
  }

  // ==================== Variants ====================

  async addVariant(productId: string, dto: CreateVariantDto) {
    const product = await this.productRepo.findById(productId);
    if (!product) throw new EntityNotFoundError('Product', productId);

    if (dto.sku) {
      const taken = await this.productRepo.isSkuTaken(dto.sku);
      if (taken) throw new EntityAlreadyExistsError('SKU', dto.sku);
    }
    if (dto.barcode) {
      const taken = await this.productRepo.isBarcodeTaken(dto.barcode);
      if (taken) throw new EntityAlreadyExistsError('Barcode', dto.barcode);
    }

    const resolvedName = this.resolveVariantName(
      dto.name,
      dto.option,
      dto.value,
    );

    const variant = await this.prisma.$transaction(async (tx) => {
      const createdVariant = await tx.variant.create({
        data: {
          productId,
          name: resolvedName,
          option: dto.option?.trim() || null,
          value: dto.value?.trim() || null,
          sku: dto.sku?.trim().toUpperCase() || null,
          barcode: dto.barcode?.trim() || null,
          quantity: dto.quantity ?? 0,
          minQuantity: this.normalizeVariantMinQuantity(
            product.useStock,
            dto.minQuantity,
          ),
          purchaseNetCostCents: dto.purchaseNetCostCents ?? null,
        },
      });

      const priceLists = await tx.priceList.findMany({
        where: { productId },
        select: { id: true },
      });

      if (priceLists.length) {
        await tx.variantPrice.createMany({
          data: priceLists.map((pl) => ({
            variantId: createdVariant.id,
            priceListId: pl.id,
            priceCents: 0,
          })),
        });
      }

      if (!product.hasVariants) {
        await tx.product.update({
          where: { id: productId },
          data: {
            hasVariants: true,
            useLotsAndExpirations: false,
            quantity: 0,
            minQuantity: 0,
          },
        });
      }

      return createdVariant;
    });

    return this.enrichVariantCostResponse(variant);
  }

  async getVariants(productId: string) {
    const product = await this.productRepo.findById(productId);
    if (!product) throw new EntityNotFoundError('Product', productId);

    const variants = await this.prisma.variant.findMany({
      where: { productId },
      include: {
        images: true,
        variantPrices: {
          orderBy: { priceList: { globalPriceList: { name: 'asc' } } },
          include: {
            priceList: {
              select: { globalPriceList: { select: { name: true } }, id: true },
            },
            tierPrices: { orderBy: { minQuantity: 'asc' } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    return variants.map((variant) =>
      this.enrichVariantResponse(variant, product),
    );
  }

  async updateVariant(
    productId: string,
    variantId: string,
    dto: UpdateVariantDto,
  ) {
    const variant = await this.prisma.variant.findFirst({
      where: { id: variantId, productId },
      include: {
        product: { select: { useStock: true } },
      },
    });
    if (!variant) throw new EntityNotFoundError('Variant', variantId);

    // Exclude only THIS variant — must still reject sibling variants and parent product
    if (dto.sku !== undefined && dto.sku !== null) {
      const taken = await this.productRepo.isSkuTaken(dto.sku, {
        variantId,
      });
      if (taken) throw new EntityAlreadyExistsError('SKU', dto.sku);
    }
    if (dto.barcode !== undefined && dto.barcode !== null) {
      const taken = await this.productRepo.isBarcodeTaken(dto.barcode, {
        variantId,
      });
      if (taken) throw new EntityAlreadyExistsError('Barcode', dto.barcode);
    }

    const variantUsesStock = variant.product?.useStock ?? true;

    return this.prisma.variant
      .update({
        where: { id: variantId },
        data: {
          ...(dto.name !== undefined ||
          dto.option !== undefined ||
          dto.value !== undefined
            ? {
                name: this.resolveVariantName(
                  dto.name ?? variant.name,
                  dto.option !== undefined ? dto.option : variant.option,
                  dto.value !== undefined ? dto.value : variant.value,
                ),
              }
            : {}),
          ...(dto.option !== undefined
            ? { option: dto.option?.trim() || null }
            : {}),
          ...(dto.value !== undefined
            ? { value: dto.value?.trim() || null }
            : {}),
          ...(dto.sku !== undefined
            ? { sku: dto.sku?.trim().toUpperCase() || null }
            : {}),
          ...(dto.barcode !== undefined
            ? { barcode: dto.barcode?.trim() || null }
            : {}),
          ...(dto.quantity !== undefined ? { quantity: dto.quantity } : {}),
          ...(variantUsesStock
            ? dto.minQuantity !== undefined
              ? { minQuantity: dto.minQuantity }
              : {}
            : { minQuantity: 0 }),
          ...(dto.purchaseNetCostCents !== undefined
            ? { purchaseNetCostCents: dto.purchaseNetCostCents }
            : {}),
        },
      })
      .then((updatedVariant) => this.enrichVariantCostResponse(updatedVariant));
  }

  async removeVariant(productId: string, variantId: string) {
    const variant = await this.prisma.variant.findFirst({
      where: { id: variantId, productId },
    });
    if (!variant) throw new EntityNotFoundError('Variant', variantId);

    await this.prisma.variant.delete({ where: { id: variantId } });

    // Check if product still has variants
    const remaining = await this.prisma.variant.count({
      where: { productId },
    });
    if (remaining === 0) {
      await this.prisma.product.update({
        where: { id: productId },
        data: { hasVariants: false },
      });
    }
  }

  async getVariantPrices(productId: string, variantId: string) {
    const { product, variant } = await this.ensureProductAndVariant(
      productId,
      variantId,
    );

    const prices = await this.prisma.variantPrice.findMany({
      where: { variantId: variant.id },
      include: {
        priceList: {
          select: { id: true, globalPriceList: { select: { name: true } } },
        },
        tierPrices: { orderBy: { minQuantity: 'asc' } },
      },
      orderBy: { priceList: { globalPriceList: { name: 'asc' } } },
    });

    return prices.map((price) =>
      this.enrichVariantPriceResponse(
        price,
        product,
        variant.purchaseNetCostCents,
      ),
    );
  }

  async upsertVariantPrice(
    productId: string,
    variantId: string,
    priceListId: string,
    dto: UpsertVariantPriceDto,
  ) {
    const { product, variant } = await this.ensureProductAndVariant(
      productId,
      variantId,
    );
    await this.ensurePriceList(productId, priceListId);

    if (dto.tierPrices?.length) {
      this.validateTierPrices(dto.tierPrices);
    }

    await this.prisma.$transaction(async (tx) => {
      const variantPrice = await tx.variantPrice.upsert({
        where: {
          variantId_priceListId: { variantId: variant.id, priceListId },
        },
        update: { priceCents: dto.priceCents },
        create: {
          variantId: variant.id,
          priceListId,
          priceCents: dto.priceCents,
        },
      });

      if (dto.tierPrices !== undefined) {
        await tx.variantTierPrice.deleteMany({
          where: { variantPriceId: variantPrice.id },
        });

        if (dto.tierPrices.length) {
          await tx.variantTierPrice.createMany({
            data: dto.tierPrices.map((tier) => ({
              variantPriceId: variantPrice.id,
              minQuantity: tier.minQuantity,
              priceCents: tier.priceCents,
            })),
          });
        }
      }
    });

    const updated = await this.prisma.variantPrice.findUnique({
      where: { variantId_priceListId: { variantId: variant.id, priceListId } },
      include: {
        priceList: {
          select: { id: true, globalPriceList: { select: { name: true } } },
        },
        tierPrices: { orderBy: { minQuantity: 'asc' } },
      },
    });

    if (!updated) {
      throw new EntityNotFoundError(
        'VariantPrice',
        `${variantId}:${priceListId}`,
      );
    }

    return this.enrichVariantPriceResponse(
      updated,
      product,
      variant.purchaseNetCostCents,
    );
  }

  async bulkUpsertVariantPrices(
    productId: string,
    variantId: string,
    dto: BulkUpsertVariantPricesDto,
  ) {
    const { variant } = await this.ensureProductAndVariant(
      productId,
      variantId,
    );

    const requestedPriceListIds = dto.prices.map((p) => p.priceListId);
    const uniquePriceListIds = [...new Set(requestedPriceListIds)];

    const priceLists = await this.prisma.priceList.findMany({
      where: { id: { in: uniquePriceListIds } },
      select: { id: true, productId: true },
    });

    if (priceLists.length !== uniquePriceListIds.length) {
      const existingIds = new Set(priceLists.map((pl) => pl.id));
      const missing = uniquePriceListIds.find((id) => !existingIds.has(id));
      throw new EntityNotFoundError('PriceList', missing ?? 'unknown');
    }

    const mismatch = priceLists.find((pl) => pl.productId !== productId);
    if (mismatch) {
      throw new BusinessRuleViolationError(
        'Price list does not belong to the product',
        'PRICE_LIST_PRODUCT_MISMATCH',
      );
    }

    for (const price of dto.prices) {
      if (price.tierPrices?.length) {
        this.validateTierPrices(price.tierPrices);
      }
    }

    await this.prisma.$transaction(async (tx) => {
      for (const item of dto.prices) {
        const variantPrice = await tx.variantPrice.upsert({
          where: {
            variantId_priceListId: {
              variantId: variant.id,
              priceListId: item.priceListId,
            },
          },
          update: { priceCents: item.priceCents },
          create: {
            variantId: variant.id,
            priceListId: item.priceListId,
            priceCents: item.priceCents,
          },
        });

        if (item.tierPrices !== undefined) {
          await tx.variantTierPrice.deleteMany({
            where: { variantPriceId: variantPrice.id },
          });

          if (item.tierPrices.length) {
            await tx.variantTierPrice.createMany({
              data: item.tierPrices.map((tier) => ({
                variantPriceId: variantPrice.id,
                minQuantity: tier.minQuantity,
                priceCents: tier.priceCents,
              })),
            });
          }
        }
      }
    });

    return this.getVariantPrices(productId, variantId);
  }

  async removeVariantPrice(
    productId: string,
    variantId: string,
    priceListId: string,
  ): Promise<void> {
    const { variant } = await this.ensureProductAndVariant(
      productId,
      variantId,
    );
    const priceList = await this.ensurePriceList(productId, priceListId);

    if (priceList.globalPriceList.isDefault) {
      throw new BusinessRuleViolationError(
        'Cannot delete the default PUBLICO price list',
        'DEFAULT_PRICE_LIST_PROTECTED',
      );
    }

    const variantPrice = await this.prisma.variantPrice.findUnique({
      where: { variantId_priceListId: { variantId: variant.id, priceListId } },
      select: { id: true },
    });

    if (!variantPrice) {
      throw new EntityNotFoundError(
        'VariantPrice',
        `${variantId}:${priceListId}`,
      );
    }

    await this.prisma.variantPrice.delete({ where: { id: variantPrice.id } });
  }

  // ==================== Lots ====================

  async addLot(productId: string, dto: CreateLotDto) {
    const product = await this.productRepo.findById(productId);
    if (!product) throw new EntityNotFoundError('Product', productId);

    if (!product.useLotsAndExpirations) {
      throw new BusinessRuleViolationError(
        'Product does not use lots and expirations',
        'LOTS_NOT_ENABLED',
      );
    }

    if (product.hasVariants) {
      throw new BusinessRuleViolationError(
        'Products with variants cannot have lots',
        'PRODUCT_HAS_VARIANTS',
      );
    }

    // Check unique lot number per product
    const existing = await this.prisma.lot.findUnique({
      where: {
        productId_lotNumber: { productId, lotNumber: dto.lotNumber.trim() },
      },
    });
    if (existing) {
      throw new EntityAlreadyExistsError('Lot', dto.lotNumber);
    }

    return this.prisma.lot.create({
      data: {
        productId,
        lotNumber: dto.lotNumber.trim(),
        quantity: dto.quantity ?? 0,
        manufactureDate: dto.manufactureDate
          ? new Date(dto.manufactureDate)
          : null,
        expirationDate: new Date(dto.expirationDate),
      },
    });
  }

  async getLots(productId: string) {
    const product = await this.productRepo.findById(productId);
    if (!product) throw new EntityNotFoundError('Product', productId);

    return this.prisma.lot.findMany({
      where: { productId },
      orderBy: { expirationDate: 'asc' },
    });
  }

  async updateLot(productId: string, lotId: string, dto: UpdateLotDto) {
    const lot = await this.prisma.lot.findFirst({
      where: { id: lotId, productId },
    });
    if (!lot) throw new EntityNotFoundError('Lot', lotId);

    return this.prisma.lot.update({
      where: { id: lotId },
      data: {
        ...(dto.quantity !== undefined ? { quantity: dto.quantity } : {}),
        ...(dto.manufactureDate !== undefined
          ? {
              manufactureDate: dto.manufactureDate
                ? new Date(dto.manufactureDate)
                : null,
            }
          : {}),
        ...(dto.expirationDate !== undefined
          ? { expirationDate: new Date(dto.expirationDate) }
          : {}),
      },
    });
  }

  async removeLot(productId: string, lotId: string) {
    const lot = await this.prisma.lot.findFirst({
      where: { id: lotId, productId },
    });
    if (!lot) throw new EntityNotFoundError('Lot', lotId);
    await this.prisma.lot.delete({ where: { id: lotId } });
  }

  // ==================== Price Lists ====================

  async getPriceLists(productId: string) {
    const product = await this.productRepo.findById(productId);
    if (!product) throw new EntityNotFoundError('Product', productId);

    const lists = await this.prisma.priceList.findMany({
      where: { productId },
      include: {
        tierPrices: { orderBy: { minQuantity: 'asc' } },
        globalPriceList: { select: { name: true } },
      },
      orderBy: { globalPriceList: { name: 'asc' } },
    });

    return lists.map((pl) => this.enrichPriceListResponse(pl, product));
  }

  async updatePriceList(
    productId: string,
    priceListId: string,
    dto: UpdatePriceListDto,
  ) {
    const product = await this.productRepo.findById(productId);
    if (!product) throw new EntityNotFoundError('Product', productId);

    const priceList = await this.prisma.priceList.findFirst({
      where: { id: priceListId, productId },
    });
    if (!priceList) throw new EntityNotFoundError('PriceList', priceListId);

    // Validate tier prices if provided
    if (dto.tierPrices?.length) {
      this.validateTierPrices(dto.tierPrices);
    }

    // Update price and replace tiers if provided
    const updated = await this.prisma.priceList.update({
      where: { id: priceListId },
      data: {
        ...(dto.priceCents !== undefined ? { priceCents: dto.priceCents } : {}),
        ...(dto.tierPrices !== undefined
          ? {
              tierPrices: {
                deleteMany: {},
                create: dto.tierPrices.map((t) => ({
                  minQuantity: t.minQuantity,
                  priceCents: t.priceCents,
                })),
              },
            }
          : {}),
      },
      include: {
        tierPrices: { orderBy: { minQuantity: 'asc' } },
        globalPriceList: { select: { name: true } },
      },
    });

    return this.enrichPriceListResponse(updated, product);
  }

  // ==================== Images ====================

  async addImage(productId: string, dto: CreateImageDto) {
    const product = await this.productRepo.findById(productId);
    if (!product) throw new EntityNotFoundError('Product', productId);

    if (dto.variantId) {
      const variant = await this.prisma.variant.findFirst({
        where: { id: dto.variantId, productId },
        select: { id: true },
      });

      if (!variant) {
        throw new BusinessRuleViolationError(
          'Variant does not belong to the product',
          'VARIANT_PRODUCT_MISMATCH',
        );
      }
    }

    // If setting as main, unset existing main image
    if (dto.isMain) {
      await this.prisma.productImage.updateMany({
        where: { productId, isMain: true, variantId: dto.variantId ?? null },
        data: { isMain: false },
      });
    }

    try {
      return await this.prisma.productImage.create({
        data: {
          productId,
          variantId: dto.variantId ?? null,
          url: dto.url,
          isMain: dto.isMain ?? false,
          sortOrder: dto.sortOrder ?? 0,
        },
      });
    } catch (error) {
      if (this.isMainImageUniqueConstraintError(error)) {
        throw new BusinessRuleViolationError(
          'Only one main image is allowed per product or variant scope',
          'MAIN_IMAGE_CONFLICT',
        );
      }

      throw error;
    }
  }

  async getImages(productId: string) {
    const product = await this.productRepo.findById(productId);
    if (!product) throw new EntityNotFoundError('Product', productId);

    return this.prisma.productImage.findMany({
      where: { productId },
      orderBy: [{ isMain: 'desc' }, { sortOrder: 'asc' }],
    });
  }

  async setMainImage(productId: string, imageId: string) {
    const image = await this.prisma.productImage.findFirst({
      where: { id: imageId, productId },
    });
    if (!image) throw new EntityNotFoundError('ProductImage', imageId);

    // Unset all main images for the same scope (product or variant)
    await this.prisma.productImage.updateMany({
      where: { productId, isMain: true, variantId: image.variantId },
      data: { isMain: false },
    });

    try {
      return await this.prisma.productImage.update({
        where: { id: imageId },
        data: { isMain: true },
      });
    } catch (error) {
      if (this.isMainImageUniqueConstraintError(error)) {
        throw new BusinessRuleViolationError(
          'Only one main image is allowed per product or variant scope',
          'MAIN_IMAGE_CONFLICT',
        );
      }

      throw error;
    }
  }

  async removeImage(productId: string, imageId: string) {
    const image = await this.prisma.productImage.findFirst({
      where: { id: imageId, productId },
    });
    if (!image) throw new EntityNotFoundError('ProductImage', imageId);
    await this.prisma.productImage.delete({ where: { id: imageId } });
  }

  // ==================== Stock operations (backward compat) ====================

  async decreaseStock(productId: string, quantity: number): Promise<Product> {
    const product = await this.productRepo.findById(productId);
    if (!product) throw new EntityNotFoundError('Product', productId);

    product.decreaseStock(quantity);
    return this.productRepo.save(product);
  }

  async increaseStock(productId: string, quantity: number): Promise<Product> {
    const product = await this.productRepo.findById(productId);
    if (!product) throw new EntityNotFoundError('Product', productId);

    product.increaseStock(quantity);
    return this.productRepo.save(product);
  }

  // ==================== Helpers ====================

  private resolveVariantName(
    fallbackName?: string | null,
    option?: string | null,
    value?: string | null,
  ): string {
    const normalizedOption = option?.trim();
    const normalizedValue = value?.trim();

    if (normalizedOption && normalizedValue) {
      return normalizedValue;
    }

    if (fallbackName?.trim()) {
      return fallbackName.trim();
    }

    throw new InvalidArgumentError(
      'Variant name is required when option/value are not both provided',
    );
  }

  private async ensureProductAndVariant(productId: string, variantId: string) {
    const product = await this.productRepo.findById(productId);
    if (!product) throw new EntityNotFoundError('Product', productId);

    const variant = await this.prisma.variant.findUnique({
      where: { id: variantId },
      select: { id: true, productId: true, purchaseNetCostCents: true },
    });
    if (!variant) throw new EntityNotFoundError('Variant', variantId);

    if (variant.productId !== productId) {
      throw new BusinessRuleViolationError(
        'Variant does not belong to the product',
        'VARIANT_PRODUCT_MISMATCH',
      );
    }

    return { product, variant };
  }

  private async ensurePriceList(productId: string, priceListId: string) {
    const priceList = await this.prisma.priceList.findUnique({
      where: { id: priceListId },
      select: {
        id: true,
        productId: true,
        globalPriceList: { select: { isDefault: true } },
      },
    });
    if (!priceList) throw new EntityNotFoundError('PriceList', priceListId);

    if (priceList.productId !== productId) {
      throw new BusinessRuleViolationError(
        'Price list does not belong to the product',
        'PRICE_LIST_PRODUCT_MISMATCH',
      );
    }

    return priceList;
  }

  private enrichVariantPriceResponse(
    variantPrice: {
      id: string;
      variantId: string;
      priceListId: string;
      priceCents: number;
      priceList:
        | { id: string; globalPriceList: { name: string } }
        | { globalPriceList: { name: string } };
      tierPrices: Array<{
        id: string;
        minQuantity: number;
        priceCents: number;
      }>;
    },
    product: Product,
    variantPurchaseNetCostCents: number | null,
  ) {
    const netCostCents =
      variantPurchaseNetCostCents ?? product.purchaseCost.netCents;
    const marginCents = variantPrice.priceCents - netCostCents;

    return {
      id: variantPrice.id,
      variantId: variantPrice.variantId,
      priceListId: variantPrice.priceListId,
      priceListName: variantPrice.priceList.globalPriceList.name,
      priceCents: variantPrice.priceCents,
      priceDecimal: variantPrice.priceCents / 100,
      margin: {
        amountCents: marginCents,
        amountDecimal: marginCents / 100,
        percent:
          variantPrice.priceCents > 0
            ? Math.round((marginCents / variantPrice.priceCents) * 100)
            : 0,
      },
      tierPrices: variantPrice.tierPrices.map((tier) => {
        const tierMarginCents = tier.priceCents - netCostCents;

        return {
          ...tier,
          priceDecimal: tier.priceCents / 100,
          margin: {
            amountCents: tierMarginCents,
            amountDecimal: tierMarginCents / 100,
            percent:
              tier.priceCents > 0
                ? Math.round((tierMarginCents / tier.priceCents) * 100)
                : 0,
          },
        };
      }),
    };
  }

  private enrichVariantResponse(
    variant: {
      id: string;
      productId: string;
      name: string;
      sku: string | null;
      barcode: string | null;
      quantity: number;
      minQuantity?: number;
      purchaseNetCostCents?: number | null;
      createdAt: Date;
      updatedAt: Date;
      images: unknown[];
      variantPrices: Array<{
        id: string;
        variantId: string;
        priceListId: string;
        priceCents: number;
        priceList:
          | { id: string; globalPriceList: { name: string } }
          | { globalPriceList: { name: string } };
        tierPrices: Array<{
          id: string;
          minQuantity: number;
          priceCents: number;
        }>;
      }>;
      option?: string | null;
      value?: string | null;
    },
    product: Product,
  ) {
    return {
      ...this.enrichVariantCostResponse(variant),
      minQuantity: variant.minQuantity ?? 0,
      variantPrices: variant.variantPrices.map((vp) =>
        this.enrichVariantPriceResponse(
          vp,
          product,
          variant.purchaseNetCostCents ?? null,
        ),
      ),
    };
  }

  private normalizeVariantMinQuantity(
    useStock: boolean,
    minQuantity?: number,
  ): number {
    if (!useStock) return 0;
    return minQuantity ?? 0;
  }

  private enrichVariantCostResponse<T extends object>(
    variant: T,
  ): T & {
    purchaseNetCostCents: number | null;
    purchaseNetCostDecimal: number | null;
  } {
    const purchaseNetCostCents =
      (variant as { purchaseNetCostCents?: number | null })
        .purchaseNetCostCents ?? null;

    return {
      ...variant,
      purchaseNetCostCents,
      purchaseNetCostDecimal:
        purchaseNetCostCents === null ? null : purchaseNetCostCents / 100,
    } as T & {
      purchaseNetCostCents: number | null;
      purchaseNetCostDecimal: number | null;
    };
  }

  private validateTierPrices(
    tiers: Array<{ minQuantity: number; priceCents: number }>,
  ): void {
    const thresholds = tiers.map((t) => t.minQuantity);
    const seen = new Set<number>();

    // Check integer, >= 0, ascending and unique (strict)
    for (let i = 0; i < thresholds.length; i++) {
      if (!Number.isInteger(thresholds[i])) {
        throw new InvalidArgumentError(
          'Tier quantity thresholds must be integers >= 0',
        );
      }
      if (thresholds[i] < 0) {
        throw new InvalidArgumentError('Tier quantity thresholds must be >= 0');
      }
      if (seen.has(thresholds[i])) {
        throw new BusinessRuleViolationError(
          `Tier thresholds must be unique. Duplicate value: ${thresholds[i]}`,
          'INVALID_TIER_SEQUENCE',
        );
      }
      seen.add(thresholds[i]);
      if (i > 0 && thresholds[i] <= thresholds[i - 1]) {
        throw new BusinessRuleViolationError(
          `Tier thresholds must be strictly ascending and unique: ${thresholds[i - 1]} -> ${thresholds[i]}`,
          'INVALID_TIER_SEQUENCE',
        );
      }
    }
  }

  private enrichPriceListResponse(
    priceList: {
      id: string;
      productId: string;
      globalPriceList: { name: string };
      priceCents: number;
      tierPrices: Array<{
        id: string;
        minQuantity: number;
        priceCents: number;
      }>;
    },
    product: Product,
  ) {
    const netCostCents = product.purchaseCost.netCents;
    const salePriceCents = priceList.priceCents;
    const marginCents = salePriceCents - netCostCents;
    const marginPercent =
      salePriceCents > 0 ? Math.round((marginCents / salePriceCents) * 100) : 0;

    return {
      ...priceList,
      name: priceList.globalPriceList.name,
      priceDecimal: priceList.priceCents / 100,
      margin: {
        amountCents: marginCents,
        amountDecimal: marginCents / 100,
        percent: marginPercent,
      },
      tierPrices: priceList.tierPrices.map((t) => ({
        ...t,
        priceDecimal: t.priceCents / 100,
        margin: {
          amountCents: t.priceCents - netCostCents,
          amountDecimal: (t.priceCents - netCostCents) / 100,
          percent:
            t.priceCents > 0
              ? Math.round(((t.priceCents - netCostCents) / t.priceCents) * 100)
              : 0,
        },
      })),
    };
  }

  private isMainImageUniqueConstraintError(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }

  private async buildFullResponse(productId: string) {
    const product = await this.productRepo.findById(productId);
    if (!product) throw new EntityNotFoundError('Product', productId);

    const [priceLists, variants, images, lots] = await Promise.all([
      this.prisma.priceList.findMany({
        where: { productId },
        include: {
          tierPrices: { orderBy: { minQuantity: 'asc' } },
          globalPriceList: { select: { name: true, isDefault: true } },
        },
        orderBy: { globalPriceList: { name: 'asc' } },
      }),
      product.hasVariants
        ? this.prisma.variant.findMany({
            where: { productId },
            include: {
              images: true,
              variantPrices: {
                orderBy: { priceList: { globalPriceList: { name: 'asc' } } },
                include: {
                  priceList: {
                    select: {
                      id: true,
                      globalPriceList: { select: { name: true } },
                    },
                  },
                  tierPrices: { orderBy: { minQuantity: 'asc' } },
                },
              },
            },
            orderBy: { createdAt: 'asc' },
          })
        : Promise.resolve([]),
      this.prisma.productImage.findMany({
        where: { productId, variantId: null },
        orderBy: [{ isMain: 'desc' }, { sortOrder: 'asc' }],
      }),
      product.useLotsAndExpirations
        ? this.prisma.lot.findMany({
            where: { productId },
            orderBy: { expirationDate: 'asc' },
          })
        : Promise.resolve([]),
    ]);

    const publicoPriceCents =
      priceLists.find((pl) => pl.globalPriceList?.isDefault)?.priceCents ?? 0;

    return {
      ...product.toResponse(),
      priceCents: publicoPriceCents,
      priceDecimal: publicoPriceCents / 100,
      priceLists: priceLists.map((pl) =>
        this.enrichPriceListResponse(pl, product),
      ),
      variants: variants.map((variant) =>
        this.enrichVariantResponse(variant, product),
      ),
      images,
      lots,
    };
  }
}
