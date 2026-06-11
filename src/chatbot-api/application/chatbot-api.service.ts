import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  PUBLIC_CATALOG_REPOSITORY,
  type IPublicCatalogRepository,
} from '../../public-catalog/application/ports/public-catalog.repository';
import type {
  ProductDetailWithIncludes,
  ProductWithIncludes,
} from '../../public-catalog/application/mappers/public-product.mapper';
import type {
  CatalogItemResponse,
  ChatbotStockState,
} from '../presentation/dto/catalog-item.response';
import type { StockCheckResponse } from '../presentation/dto/stock-check.response';

type CatalogSearchInput = {
  q: string;
  limit?: number;
};

@Injectable()
export class ChatbotApiService {
  constructor(
    @Inject(PUBLIC_CATALOG_REPOSITORY)
    private readonly publicCatalogRepository: IPublicCatalogRepository,
  ) {}

  async searchCatalog(
    input: CatalogSearchInput,
  ): Promise<CatalogItemResponse[]> {
    const { items } = await this.publicCatalogRepository.findProducts({
      q: input.q.trim(),
      sort: 'relevance',
      page: 1,
      limit: input.limit ?? 10,
    });

    return items.map(toCatalogItemResponse);
  }

  async checkStock(productId: string): Promise<StockCheckResponse> {
    const product =
      await this.publicCatalogRepository.findProductById(productId);

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    return toStockCheckResponse(product);
  }
}

function deriveStockState(
  useStock: boolean,
  quantity: number,
  minQuantity: number,
): ChatbotStockState {
  if (!useStock) return 'not_managed';
  if (quantity <= 0) return 'out_of_stock';
  if (quantity <= minQuantity) return 'low_stock';
  return 'available';
}

function deriveAggregateStock(product: ProductWithIncludes): {
  status: ChatbotStockState;
  quantity: number | null;
} {
  if (!product.useStock) {
    return { status: 'not_managed', quantity: null };
  }

  if (!product.hasVariants || product.variants.length === 0) {
    return {
      status: deriveStockState(
        product.useStock,
        product.quantity,
        product.minQuantity,
      ),
      quantity: product.quantity,
    };
  }

  const states = product.variants.map((variant) =>
    deriveStockState(product.useStock, variant.quantity, variant.minQuantity),
  );

  if (states.includes('available')) {
    return { status: 'available', quantity: product.quantity };
  }

  if (states.includes('low_stock')) {
    return { status: 'low_stock', quantity: product.quantity };
  }

  return { status: 'out_of_stock', quantity: product.quantity };
}

function toCatalogItemResponse(
  product: ProductWithIncludes,
): CatalogItemResponse {
  return {
    productId: product.id,
    name: product.name,
    brand: product.brand?.name ?? null,
    imageUrl: product.images[0]?.url ?? null,
    description: product.description,
    price: {
      priceCents: product.priceLists[0]?.priceCents ?? null,
      fromPriceCents: resolveFromPriceCents(product),
      promoPriceCents: null,
      promotionEvaluationStatus: 'needs_human_review',
    },
    stock: deriveAggregateStock(product),
    packageInfo: {
      weightGrams: null,
      dimensions: null,
    },
    variants: product.variants.map((variant) => ({
      variantId: variant.id,
      name: variant.name,
      option: variant.option,
      value: variant.value,
      priceCents: variant.variantPrices[0]?.priceCents ?? null,
      stock: {
        status: deriveStockState(
          product.useStock,
          variant.quantity,
          variant.minQuantity,
        ),
        quantity: product.useStock ? variant.quantity : null,
      },
    })),
  };
}

function toStockCheckResponse(
  product: ProductDetailWithIncludes,
): StockCheckResponse {
  return {
    productId: product.id,
    name: product.name,
    stock: product.useStock
      ? {
          status: deriveStockState(
            product.useStock,
            product.quantity,
            product.minQuantity,
          ),
          quantity: product.quantity,
        }
      : { status: 'not_managed', quantity: null },
    variants: product.variants.map((variant) => ({
      variantId: variant.id,
      name: variant.name,
      option: variant.option,
      value: variant.value,
      stock: product.useStock
        ? {
            status: deriveStockState(
              product.useStock,
              variant.quantity,
              variant.minQuantity,
            ),
            quantity: variant.quantity,
          }
        : { status: 'not_managed', quantity: null },
    })),
  };
}

function resolveFromPriceCents(product: ProductWithIncludes): number | null {
  const productPrice = product.priceLists[0]?.priceCents ?? null;

  if (!product.hasVariants || product.variants.length === 0) {
    return productPrice;
  }

  const variantPrices = product.variants
    .map((variant) => variant.variantPrices[0]?.priceCents)
    .filter((price): price is number => price != null);

  if (variantPrices.length === 0) {
    return productPrice;
  }

  return Math.min(...variantPrices);
}
