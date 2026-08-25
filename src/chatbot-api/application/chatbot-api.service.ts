import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
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
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';
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
import type { BotSaleResponse } from '../presentation/dto/bot-sale.response';
import type { AttachReceiptResponse } from '../presentation/dto/attach-receipt.request';
import type { PaymentDetailResponse } from '../presentation/dto/payment-detail.response';
import type {
  OrderHistoryItem,
  OrderHistoryPayment,
  OrderHistoryResponse,
} from '../presentation/dto/order-history.response';
import { SalesService } from '../../sales/sales.service';
import { SALE_REPOSITORY } from '../../sales/domain/sale.repository';
import type { ISaleRepository } from '../../sales/domain/sale.repository';

// ── Bot Sale Input Types ────────────────────────────────────────────────────

export type RegisterBotSaleInput = {
  cashierUserId: string;
  customerId: string;
  shippingAddressId?: string | null;
  items: Array<{
    productId: string;
    variantId?: string | null;
    productName: string;
    variantName?: string | null;
    quantity: number;
    unitPriceCents: number;
  }>;
  idempotencyKey: string;
};

export type AttachReceiptInput = {
  saleId: string;
  mediaUrl: string;
  declaredAmountCents: number;
  declaredDate?: Date | null;
  declaredReference?: string | null;
};

export type SetDeliveryMetadataInput = {
  saleId: string;
  carrierName: string | null;
  trackingRef: string | null;
  estimatedDeliveryAt: Date | null;
};

export type CancelBotSaleInput = {
  saleId: string;
  reason: import('../../sales/domain/sale.entity').SaleCancelReason;
  cashierUserId: string;
};

export type GetOrderHistoryInput = {
  phoneCountryCode: string;
  phone: string;
  limit?: number;
};

type CatalogSearchInput = {
  q: string;
  limit?: number;
};

type OrderHistorySaleRecord = Prisma.SaleGetPayload<{
  include: {
    items: true;
    payments: true;
    shippingAddress: true;
  };
}>;

type OrderHistorySaleItemRecord = OrderHistorySaleRecord['items'][number];
type OrderHistorySalePaymentRecord = OrderHistorySaleRecord['payments'][number];

@Injectable()
export class ChatbotApiService {
  constructor(
    @Inject(PUBLIC_CATALOG_REPOSITORY)
    private readonly publicCatalogRepository: IPublicCatalogRepository,
    @Inject(CUSTOMER_REPOSITORY)
    private readonly customerRepository: ICustomerRepository,
    @Inject(EVALUATE_CART_PROMOTIONS_USE_CASE)
    private readonly evaluateCartPromotionsUseCase: IEvaluateCartPromotionsUseCase,
    private readonly salesService: SalesService,
    // Q3 / WU2 — bot registration uses the SALE_REPOSITORY port's atomic
    // idempotency acquire (mirrors the POS charge / payment / cancel
    // pattern). The token returned on `acquired` is stamped SUCCEEDED via
    // `markSaleRegistrationIdempotencySucceeded` after `confirmBotSale`.
    @Inject(SALE_REPOSITORY)
    private readonly saleRepository: ISaleRepository,
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

  // ── Bot Sale Operations ─────────────────────────────────────────────────────

  /**
   * Register a bot-created ONLINE sale.
   *
   * Q3 / WU2 — atomic idempotency: mirrors the POS charge pattern
   * (`acquireChargeIdempotency`) exactly. The four outcomes are:
   *
   * - `replay`    → return the cached `BotSaleResponse` (preserves the
   *                 original saleId / folio / totals).
   * - `conflict`  → same key, different payload hash →
   *                 `BusinessRuleViolationError('IDEMPOTENCY_KEY_CONFLICT', ...)`
   *                 (DomainExceptionFilter maps to 409).
   * - `in_flight` → same key, same payload, still running →
   *                 `BusinessRuleViolationError('IDEMPOTENCY_KEY_IN_FLIGHT', ...)`
   *                 (also 409).
   * - `acquired`  → proceed to `confirmBotSale`, then stamp SUCCEEDED.
   *
   * The `requestHash` is `SHA-256(JSON.stringify(canonicalPayload))` (D9)
   * over `{ cashierUserId, customerId, shippingAddressId, items }` with
   * items sorted by `(productId, variantId)`. Display names are
   * intentionally excluded so re-labels never break replay.
   *
   * The idempotency key itself is validated upstream by
   * `ParseIdempotencyKeyPipe` (WU2-03) — by the time control reaches this
   * method, `input.idempotencyKey` is a non-empty trimmed string
   * (≤ 200 chars).
   *
   * D10: `FAILED` is never written. If `confirmBotSale` throws after
   * `acquired`, the slot stays `IN_FLIGHT`; the next acquire for the same
   * key returns `in_flight` (matching hash) or `conflict` (mismatched
   * hash). Manual cleanup is the accepted mitigation.
   */
  async registerBotSale(input: RegisterBotSaleInput): Promise<BotSaleResponse> {
    const requestHash = computeRegisterBotSaleRequestHash(input);

    const idempotency =
      await this.saleRepository.acquireSaleRegistrationIdempotency(
        input.idempotencyKey,
        requestHash,
      );

    if (idempotency.kind === 'replay') {
      // The cached payload is whatever the previous successful call
      // stamped into `responseJson`. Cast through `unknown` so legacy
      // cached rows survive the wire-evolution (WU3 adds
      // `discountCents`; pre-WU3 rows simply lack the field).
      return idempotency.payload as BotSaleResponse;
    }

    if (idempotency.kind === 'conflict') {
      throw new BusinessRuleViolationError(
        'Idempotency key was already used with a different payload',
        'IDEMPOTENCY_KEY_CONFLICT',
      );
    }

    if (idempotency.kind === 'in_flight') {
      throw new BusinessRuleViolationError(
        'Idempotency key is still being processed for a matching payload',
        'IDEMPOTENCY_KEY_IN_FLIGHT',
      );
    }

    // idempotency.kind === 'acquired'
    const token = idempotency.token;
    const confirmedSale = await this.salesService.confirmBotSale({
      cashierUserId: input.cashierUserId,
      customerId: input.customerId,
      shippingAddressId: input.shippingAddressId ?? null,
      items: input.items,
    });

    const response: BotSaleResponse = {
      saleId: confirmedSale.saleId,
      folio: confirmedSale.folio,
      paymentStatus: confirmedSale.paymentStatus,
      channel: confirmedSale.channel,
      deliveryStatus: confirmedSale.deliveryStatus,
      totalCents: confirmedSale.totalCents,
      paidCents: confirmedSale.paidCents,
      debtCents: confirmedSale.debtCents,
      confirmedAt: confirmedSale.confirmedAt,
    };

    await this.saleRepository.markSaleRegistrationIdempotencySucceeded(
      token,
      confirmedSale.saleId,
      response,
    );

    return response;
  }

  /**
   * Attach transfer receipt evidence to a pending sale.
   * The receipt stays PENDING until a human confirms or rejects it.
   */
  async attachReceipt(
    input: AttachReceiptInput,
  ): Promise<AttachReceiptResponse> {
    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.tenantPrisma.getTenantId();

    const receipt = await prisma.receiptEvidence.create({
      data: {
        id: randomUUID(),
        saleId: input.saleId,
        tenantId,
        mediaUrl: input.mediaUrl,
        declaredAmountCents: input.declaredAmountCents,
        declaredDate: input.declaredDate ?? null,
        declaredReference: input.declaredReference ?? null,
        status: 'PENDING',
      },
    });

    return { receiptId: receipt.id, status: 'PENDING' };
  }

  /**
   * Record delivery carrier metadata on a sale.
   * Also marks the delivery status as SHIPPED.
   */
  async setDeliveryMetadata(input: SetDeliveryMetadataInput): Promise<void> {
    const prisma = this.tenantPrisma.getClient();

    const sale = await prisma.sale.findUnique({
      where: { id: input.saleId },
      include: {
        items: true,
        payments: true,
        shippingAddress: true,
      },
    });

    if (
      !sale ||
      sale.status !== 'CONFIRMED' ||
      sale.paymentStatus !== 'PAID' ||
      sale.channel !== 'ONLINE' ||
      sale.deliveryStatus === 'DELIVERED'
    ) {
      throw new BusinessRuleViolationError(
        'Delivery metadata can only be set on paid confirmed ONLINE sales before delivery',
        'SALE_DELIVERY_NOT_READY',
      );
    }

    await prisma.sale.update({
      where: { id: input.saleId },
      data: {
        carrierName: input.carrierName,
        trackingRef: input.trackingRef,
        estimatedDeliveryAt: input.estimatedDeliveryAt,
        deliveryStatus: 'SHIPPED',
      },
    });
  }

  /**
   * Cancel a bot-created sale. Delegates to SalesService.cancelSale.
   * The cashierUserId must match the sale's original creator (userId FK).
   */
  async cancelBotSale(input: CancelBotSaleInput) {
    return this.salesService.cancelSale(input.saleId, input.cashierUserId, {
      reason: input.reason,
    });
  }

  /**
   * Q1 / WU1 — Return the active tenant `PaymentDetail` (bank account the
   * bot tells the customer to transfer to). Tenant-scoped via CLS, ordered
   * by `updatedAt DESC` per D2 so multi-active rows return the newest.
   * Throws `BusinessRuleViolationError('NO_ACTIVE_PAYMENT_DETAIL', ...)`
   * when the tenant has no active account — the `DomainExceptionFilter`
   * translates that to 404.
   */
  async getActivePaymentDetail(): Promise<PaymentDetailResponse> {
    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.tenantPrisma.getTenantId();

    const active = await prisma.paymentDetail.findFirst({
      where: { tenantId, isActive: true },
      orderBy: { updatedAt: 'desc' },
    });

    if (!active) {
      throw new BusinessRuleViolationError(
        'No active payment detail for tenant',
        'NO_ACTIVE_PAYMENT_DETAIL',
      );
    }

    return {
      id: active.id,
      bankName: active.bankName,
      beneficiary: active.beneficiary,
      clabe: active.clabe,
      accountNumber: active.accountNumber,
      isActive: active.isActive,
      updatedAt: active.updatedAt.toISOString(),
    };
  }

  /**
   * Return recent confirmed sales for a customer looked up by WhatsApp phone.
   * Used by the bot for "same as last time" reorder flows.
   */
  async getOrderHistoryByPhone(
    input: GetOrderHistoryInput,
  ): Promise<OrderHistoryResponse[]> {
    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.tenantPrisma.getTenantId();
    const phoneCountryCode = normalizePhonePart(input.phoneCountryCode);
    const phone = normalizePhonePart(input.phone);

    const customer = await this.customerRepository.findByPhone(
      tenantId,
      phoneCountryCode,
      phone,
    );
    if (!customer) {
      return [];
    }

    const sales = await prisma.sale.findMany({
      where: {
        tenantId,
        customerId: customer.id,
        status: 'CONFIRMED',
      },
      include: {
        items: true,
        payments: true,
        shippingAddress: true,
      },
      orderBy: { confirmedAt: 'desc' },
      take: input.limit ?? 5,
    });

    return sales.map(toOrderHistoryResponse);
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

/**
 * Build the canonical request hash for `registerBotSale` (D9).
 *
 * The hash is `SHA-256(JSON.stringify(canonicalPayload))` over a fixed
 * subset of the bot's input — display-name fields like `productName` /
 * `variantName` are intentionally excluded so that catalog re-labels do
 * not break idempotent replay. Items are sorted ascending by
 * `(productId, variantId)` so the same cart in a different order produces
 * the same hash (mirrors `sortPaymentsForHash` for the POS charge path).
 *
 * `shippingAddressId` is included as-is (null when omitted) so two
 * requests that differ only by shipping address are flagged as a
 * `conflict`, not a silent replay.
 */
function computeRegisterBotSaleRequestHash(
  input: RegisterBotSaleInput,
): string {
  const canonicalPayload = {
    cashierUserId: input.cashierUserId,
    customerId: input.customerId,
    shippingAddressId: input.shippingAddressId ?? null,
    items: [...input.items]
      .map((item) => ({
        productId: item.productId,
        variantId: item.variantId ?? null,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
      }))
      .sort((a, b) =>
        `${a.productId}|${a.variantId ?? ''}`.localeCompare(
          `${b.productId}|${b.variantId ?? ''}`,
        ),
      ),
  };

  return createHash('sha256')
    .update(JSON.stringify(canonicalPayload))
    .digest('hex');
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

function toOrderHistoryResponse(
  sale: OrderHistorySaleRecord,
): OrderHistoryResponse {
  return {
    saleId: sale.id,
    folio: sale.folio ?? null,
    confirmedAt: sale.confirmedAt?.toISOString() ?? null,
    channel: sale.channel,
    deliveryStatus: sale.deliveryStatus,
    paymentStatus: sale.paymentStatus ?? null,
    totalCents: sale.totalCents,
    paidCents: sale.paidCents,
    debtCents: sale.debtCents,
    items: (sale.items ?? []).map(
      (item: OrderHistorySaleItemRecord): OrderHistoryItem => ({
        productId: item.productId,
        variantId: item.variantId ?? null,
        productName: item.productName,
        variantName: item.variantName ?? null,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
      }),
    ),
    payments: (sale.payments ?? []).map(
      (payment: OrderHistorySalePaymentRecord): OrderHistoryPayment => ({
        method: payment.method,
        amountCents: payment.amountCents,
        reference: payment.reference ?? null,
      }),
    ),
    shippingAddress: sale.shippingAddress
      ? {
          street: sale.shippingAddress.street ?? null,
          zipCode: sale.shippingAddress.zipCode ?? null,
        }
      : null,
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
