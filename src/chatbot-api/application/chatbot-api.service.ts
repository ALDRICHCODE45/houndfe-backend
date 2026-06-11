import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Customer } from '../../customers/domain/customer.entity';
import {
  CUSTOMER_REPOSITORY,
  type ICustomerRepository,
} from '../../customers/domain/customer.repository';
import {
  PUBLIC_CATALOG_REPOSITORY,
  type IPublicCatalogRepository,
} from '../../public-catalog/application/ports/public-catalog.repository';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  EVALUATE_CART_PROMOTIONS_USE_CASE,
  type CartEvaluationResult,
  type CartItemForEvaluation,
  type IEvaluateCartPromotionsUseCase,
} from '../../promotions/application/ports/evaluate-cart-promotions.port';
import type {
  ProductDetailWithIncludes,
  ProductWithIncludes,
} from '../../public-catalog/application/mappers/public-product.mapper';
import type {
  CatalogItemResponse,
  ChatbotStockState,
} from '../presentation/dto/catalog-item.response';
import type {
  CustomerLookupResponse,
  CustomerProfileResponse,
  CustomerUpsertResponse,
} from '../presentation/dto/customer-lookup.response';
import type { CustomerUpsertRequestDto } from '../presentation/dto/customer-upsert.request';
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
    @Inject(CUSTOMER_REPOSITORY)
    private readonly customerRepository: ICustomerRepository,
    @Inject(EVALUATE_CART_PROMOTIONS_USE_CASE)
    private readonly evaluateCartPromotionsUseCase: IEvaluateCartPromotionsUseCase,
    private readonly tenantPrisma: TenantPrismaService,
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

  async evaluateCart(input: {
    items: CartItemForEvaluation[];
  }): Promise<CartEvaluationResult> {
    return this.evaluateCartPromotionsUseCase.execute(input);
  }

  async findCustomerByPhone(input: {
    phoneCountryCode: string;
    phone: string;
  }): Promise<CustomerLookupResponse> {
    const tenantId = this.tenantPrisma.getTenantId();
    const phoneCountryCode = normalizePhonePart(input.phoneCountryCode);
    const phone = normalizePhonePart(input.phone);
    const customer = await this.customerRepository.findByPhone(
      tenantId,
      phoneCountryCode,
      phone,
    );

    if (!customer) {
      return { found: false, customer: null };
    }

    return {
      found: true,
      customer: await this.buildCustomerProfile(customer),
    };
  }

  async upsertCustomerProfile(
    input: CustomerUpsertRequestDto,
  ): Promise<CustomerUpsertResponse> {
    const tenantId = this.tenantPrisma.getTenantId();
    const phoneCountryCode = normalizePhonePart(input.phoneCountryCode);
    const phone = normalizePhonePart(input.phone);
    const existingCustomer = await this.customerRepository.findByPhone(
      tenantId,
      phoneCountryCode,
      phone,
    );

    const customer = existingCustomer
      ? updateCustomer(existingCustomer, input, phoneCountryCode, phone)
      : Customer.create({
          id: crypto.randomUUID(),
          firstName: input.firstName,
          lastName: input.lastName,
          phoneCountryCode,
          phone,
          preferredPaymentMethod: input.preferredPaymentMethod,
        });

    await this.customerRepository.save(customer);
    await this.upsertCustomerAddress(customer.id, input);

    return {
      status: existingCustomer ? 'updated' : 'created',
      customer: await this.buildCustomerProfile(customer),
    };
  }

  private async buildCustomerProfile(
    customer: Customer,
  ): Promise<CustomerProfileResponse> {
    const prisma = this.tenantPrisma.getClient();
    const address = await prisma.customerAddress.findFirst({
      where: { customerId: customer.id },
      orderBy: { createdAt: 'asc' },
    });

    return {
      customerId: customer.id,
      firstName: customer.firstName,
      lastName: customer.lastName,
      phoneCountryCode: customer.phoneCountryCode,
      phone: customer.phone,
      preferredPaymentMethod: customer.preferredPaymentMethod,
      address: address
        ? {
            id: address.id,
            label: address.label,
            street: address.street,
            exteriorNumber: address.exteriorNumber,
            interiorNumber: address.interiorNumber,
            zipCode: address.zipCode,
            neighborhood: address.neighborhood,
            municipality: address.municipality,
            city: address.city,
            state: address.state,
            visualReferences: address.visualReferences,
            carrierPhone: address.carrierPhone,
          }
        : null,
    };
  }

  private async upsertCustomerAddress(
    customerId: string,
    input: CustomerUpsertRequestDto,
  ): Promise<void> {
    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.tenantPrisma.getTenantId();
    const existingAddress = await prisma.customerAddress.findFirst({
      where: { customerId },
      orderBy: { createdAt: 'asc' },
    });
    const addressData = {
      label: input.address.label?.trim() || null,
      street: input.address.street.trim(),
      exteriorNumber: input.address.exteriorNumber?.trim() || null,
      interiorNumber: input.address.interiorNumber?.trim() || null,
      zipCode: input.address.zipCode?.trim() || null,
      neighborhood: input.address.neighborhood?.trim() || null,
      municipality: input.address.municipality?.trim() || null,
      city: input.address.city?.trim() || null,
      state: input.address.state ?? null,
      visualReferences: input.address.visualReferences?.trim() || null,
      carrierPhone: input.address.carrierPhone
        ? normalizePhonePart(input.address.carrierPhone)
        : null,
    };

    if (existingAddress) {
      await prisma.customerAddress.update({
        where: { id: existingAddress.id },
        data: addressData,
      });
      return;
    }

    await prisma.customerAddress.create({
      data: {
        customerId,
        tenantId,
        ...addressData,
      },
    });
  }
}

function updateCustomer(
  customer: Customer,
  input: CustomerUpsertRequestDto,
  phoneCountryCode: string,
  phone: string,
): Customer {
  customer.firstName = input.firstName.trim();
  customer.lastName = input.lastName?.trim() || null;
  customer.phoneCountryCode = phoneCountryCode;
  customer.phone = phone;
  customer.preferredPaymentMethod =
    input.preferredPaymentMethod?.trim() || null;
  customer.updatedAt = new Date();
  return customer;
}

function normalizePhonePart(value: string): string {
  return value.replace(/\D/g, '');
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
