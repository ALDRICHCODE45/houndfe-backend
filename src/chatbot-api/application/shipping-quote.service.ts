/**
 * shipping-zones / T3 (S5-S9) — bot shipping quote.
 *
 * 1. Validate the lines (one per product/variant, products and variants of
 *    this sucursal) and resolve the customer by phone and the destination
 *    (saved address of that customer XOR loose fields).
 * 2. Zone of the destination postal code (T1). Unknown or inactive → PENDING
 *    and DENIED → no quote: nothing is priced, stored or charged. The bot
 *    opens the DELIVERY_ZONE intake itself (it alone has the conversation
 *    reference and the last customer message time).
 * 3. Reprice the cart with the SAME bot pricing the sale uses
 *    (`ChatbotApiService.evaluateCart`); the bot never sends prices.
 * 4. FREE / SURCHARGE: own delivery at the zone price and days, no carrier and
 *    no packaging. CARRIER_ONLY: one package (T2), the sucursal origin, every
 *    configured carrier, cheapest wins.
 * 5. Credit (S7), ETA (S9) and a persisted quote with an opaque id (S8).
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DELIVERY_ZONE_REPOSITORY,
  type IDeliveryZoneRepository,
} from '../../delivery-zones/domain/delivery-zone.repository';
import {
  businessToday,
  sumExpiredLotQuantity,
} from '../../inventory/domain/fefo-allocator';
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { ProductPackagingService } from '../../shipping/packaging/application/product-packaging.service';
import { ShippingSettingsService } from '../../shipping/packaging/application/shipping-settings.service';
import { buildOrderPackage } from '../../shipping/packaging/domain/order-package';
import { quoteCheapest } from '../../shipping/quotes/domain/carrier-quote.engine';
import {
  SHIPPING_CARRIERS,
  type ShippingCarrier,
} from '../../shipping/quotes/domain/shipping-carrier.port';
import {
  applyShippingCredit,
  computeShippingCredit,
} from '../../shipping/quotes/domain/shipping-credit';
import {
  resolveQuoteEta,
  type QuoteEta,
} from '../../shipping/quotes/domain/shipping-eta';
import {
  computeQuoteExpiry,
  generateQuoteToken,
  hashQuoteToken,
  normalizeLines,
  type QuoteLine,
} from '../../shipping/quotes/domain/shipping-quote-binding';
import { ShippingQuoteError } from '../../shipping/quotes/domain/shipping-quote.errors';
import {
  SHIPPING_QUOTE_REPOSITORY,
  type IShippingQuoteRepository,
  type QuoteBoxSnapshot,
  type QuoteCarrierOption,
  type QuoteDestinationSnapshot,
  type QuoteZoneSnapshot,
} from '../../shipping/quotes/domain/shipping-quote.repository';
import {
  SHIPPING_QUOTES_CONFIG,
  type ShippingQuotesConfig,
} from '../../shipping/quotes/shipping-quotes.config';
import { ChatbotApiService, sellableQuantity } from './chatbot-api.service';

export interface ShippingQuoteInput {
  phoneCountryCode: string;
  phone: string;
  items: Array<{
    productId: string;
    variantId?: string | null;
    quantity: number;
  }>;
  destination: {
    shippingAddressId?: string;
    zipCode?: string;
    state?: string;
    municipality?: string;
    neighborhood?: string;
  };
}

export type ShippingZoneStatus =
  | 'FREE'
  | 'SURCHARGE'
  | 'CARRIER_ONLY'
  | 'DENIED'
  | 'PENDING';

export interface ShippingQuoteResponse {
  quoteId: string | null;
  expiresAt: string | null;
  zoneStatus: ShippingZoneStatus;
  option: { carrier: string; service: string; etaDays: number | null } | null;
  eta: QuoteEta;
  costCents: number;
  creditCents: number;
  customerChargeCents: number;
  currency: 'MXN';
}

interface ResolvedProduct {
  id: string;
  useStock: boolean;
  hasVariants: boolean;
  quantity: number;
}

@Injectable()
export class ShippingQuoteService {
  constructor(
    private readonly chatbotApi: ChatbotApiService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly configService: ConfigService,
    @Inject(DELIVERY_ZONE_REPOSITORY)
    private readonly zones: IDeliveryZoneRepository,
    private readonly packaging: ProductPackagingService,
    private readonly shippingSettings: ShippingSettingsService,
    @Inject(SHIPPING_CARRIERS)
    private readonly carriers: ShippingCarrier[],
    @Inject(SHIPPING_QUOTE_REPOSITORY)
    private readonly quotes: IShippingQuoteRepository,
    @Inject(SHIPPING_QUOTES_CONFIG)
    private readonly config: ShippingQuotesConfig,
  ) {}

  async quote(input: ShippingQuoteInput): Promise<ShippingQuoteResponse> {
    const tenantId = this.tenantPrisma.getTenantId();
    const lines = normalizeLines(input.items);
    assertOneLinePerItem(lines);
    const products = await this.requireCatalogItems(tenantId, lines);
    const customerId = await this.resolveCustomer(tenantId, input);
    const destination = await this.resolveDestination(
      tenantId,
      customerId,
      input.destination,
    );

    const zone = await this.zones.findByZipCode(destination.zipCode);
    if (!zone || !zone.isActive) return noQuote('PENDING');
    if (zone.type === 'DENIED') return noQuote('DENIED');

    const pricing = await this.chatbotApi.evaluateCart({
      phoneCountryCode: input.phoneCountryCode,
      phone: input.phone,
      items: lines.map((line) => ({ ...line, unitPriceCents: 0 })),
    });
    const earnedCredit = computeShippingCredit(
      pricing.items,
      this.config.credit,
    );
    const stockPending = await this.lacksSellableStock(
      tenantId,
      lines,
      products,
    );
    const zoneSnapshot: QuoteZoneSnapshot = {
      zoneId: zone.id,
      zipCode: zone.zipCode,
      type: zone.type,
      surchargeCents: zone.surchargeCents,
      etaDays: zone.etaDays,
    };

    let costCents: number;
    let creditApplies: boolean;
    let baseEtaDays: number | null;
    let option: QuoteCarrierOption | null = null;
    let box: QuoteBoxSnapshot | null = null;
    let now: Date | null = null;
    if (zone.type === 'CARRIER_ONLY') {
      const carrierQuote = await this.quoteByCarrier(
        tenantId,
        lines,
        destination,
      );
      option = carrierQuote.option;
      box = carrierQuote.box;
      now = carrierQuote.chosenAt;
      costCents = carrierQuote.totalCents;
      creditApplies = true;
      baseEtaDays = option.etaDays;
    } else {
      costCents = zone.type === 'FREE' ? 0 : (zone.surchargeCents ?? 0);
      creditApplies = this.config.credit.appliesToSurcharge;
      baseEtaDays = zone.etaDays;
    }

    const charge = applyShippingCredit(
      { costCents, creditCents: earnedCredit },
      creditApplies,
    );
    const eta = resolveQuoteEta(baseEtaDays, stockPending);
    // A carrier quote is stamped with the instant its rate was chosen: the
    // engine kept only rates valid after it, so expiresAt > createdAt holds
    // (the table CHECK) however long the rest of this request takes.
    now ??= new Date();
    const expiresAt = computeQuoteExpiry(
      now,
      this.config.ttlMinutes,
      option?.validUntil ?? null,
    );
    const token = generateQuoteToken();
    await this.quotes.create({
      tenantId,
      tokenHash: hashQuoteToken(token),
      customerId,
      phoneCountryCode: input.phoneCountryCode,
      phone: input.phone,
      lines: lines.map((line) => ({
        ...line,
        finalPriceCents:
          pricing.items.find(
            (item) =>
              item.productId === line.productId &&
              (item.variantId ?? null) === line.variantId,
          )?.finalPriceCents ?? 0,
      })),
      destination,
      zone: zoneSnapshot,
      option,
      box,
      etaDays: eta.days,
      etaReason: eta.reason,
      ...charge,
      expiresAt,
      createdAt: now,
    });

    return {
      quoteId: token,
      expiresAt: expiresAt.toISOString(),
      zoneStatus: zone.type,
      option: option && {
        carrier: option.carrier,
        service: option.service,
        etaDays: option.etaDays,
      },
      eta,
      ...charge,
      currency: 'MXN',
    };
  }

  private async quoteByCarrier(
    tenantId: string,
    lines: QuoteLine[],
    destination: QuoteDestinationSnapshot,
  ) {
    const [items, boxes] = await Promise.all([
      this.packaging.resolvePackageItems(tenantId, lines),
      this.shippingSettings.listActiveBoxes(tenantId),
    ]);
    // PACKAGING_DATA_MISSING / NO_SHIPPING_BOX_FITS before the origin check:
    // they name what the store must fix on the products or boxes.
    const orderPackage = buildOrderPackage(items, boxes);
    const origin = await this.tenantPrisma
      .getClient()
      .shippingOrigin.findFirst({ where: { tenantId } });
    if (!origin) {
      throw new ShippingQuoteError(
        'SHIPPING_ORIGIN_NOT_CONFIGURED',
        'The sucursal has no shipping origin; set it before quoting by carrier',
      );
    }
    let chosenAt: Date | null = null;
    const best = await quoteCheapest(
      this.carriers,
      {
        tenantId,
        origin: {
          postalCode: origin.postalCode,
          state: origin.state,
          municipality: origin.municipality,
          neighborhood: origin.neighborhood,
          addressLine1: origin.addressLine1,
          addressLine2: origin.addressLine2,
          contactPhone: origin.contactPhone,
        },
        destination: {
          postalCode: destination.zipCode,
          state: destination.state,
          municipality: destination.municipality,
          neighborhood: destination.neighborhood,
        },
        parcel: { weightG: orderPackage.totalWeightG, ...orderPackage.dims },
      },
      {
        timeoutMs: this.config.carrierTimeoutMs,
        now: () => (chosenAt = new Date()),
      },
    );
    return {
      chosenAt: chosenAt ?? new Date(),
      totalCents: best.option.totalCents,
      option: {
        carrier: best.option.carrier,
        service: best.option.service,
        etaDays: best.option.etaDays,
        rateId: best.option.rateId,
        validUntil: best.option.validUntil,
      },
      box: {
        box: orderPackage.box,
        contentWeightG: orderPackage.contentWeightG,
        totalWeightG: orderPackage.totalWeightG,
      },
    };
  }

  private async requireCatalogItems(
    tenantId: string,
    lines: QuoteLine[],
  ): Promise<Map<string, ResolvedProduct>> {
    const client = this.tenantPrisma.getClient();
    const productIds = [...new Set(lines.map((line) => line.productId))];
    const variantIds = lines.flatMap((line) =>
      line.variantId ? [line.variantId] : [],
    );
    const [products, variants] = await Promise.all([
      client.product.findMany({
        where: { tenantId, id: { in: productIds } },
        select: { id: true, useStock: true, hasVariants: true, quantity: true },
      }),
      client.variant.findMany({
        where: { tenantId, id: { in: variantIds } },
        select: { id: true, productId: true },
      }),
    ]);
    const byId = new Map(products.map((product) => [product.id, product]));
    for (const line of lines) {
      if (!byId.has(line.productId)) {
        throw new ShippingQuoteError(
          'PRODUCT_NOT_FOUND',
          `Product ${line.productId} not found`,
        );
      }
      if (
        line.variantId &&
        !variants.some(
          (v) => v.id === line.variantId && v.productId === line.productId,
        )
      ) {
        throw new ShippingQuoteError(
          'VARIANT_NOT_FOUND',
          `Variant ${line.variantId} not found for product ${line.productId}`,
        );
      }
    }
    return byId;
  }

  private async resolveCustomer(
    tenantId: string,
    input: ShippingQuoteInput,
  ): Promise<string | null> {
    const customers = await this.tenantPrisma.getClient().customer.findMany({
      where: {
        tenantId,
        phoneCountryCode: input.phoneCountryCode,
        phone: input.phone,
      },
      take: 2,
      select: { id: true },
    });
    if (customers.length > 1) {
      throw new ShippingQuoteError(
        'CUSTOMER_PHONE_AMBIGUOUS',
        'More than one customer has this phone',
      );
    }
    return customers[0]?.id ?? null;
  }

  private async resolveDestination(
    tenantId: string,
    customerId: string | null,
    destination: ShippingQuoteInput['destination'],
  ): Promise<QuoteDestinationSnapshot> {
    const loose = [
      destination.zipCode,
      destination.state,
      destination.municipality,
      destination.neighborhood,
    ];
    if (destination.shippingAddressId !== undefined) {
      if (loose.some((value) => value !== undefined))
        throw invalidDestination();
      const address = customerId
        ? await this.tenantPrisma.getClient().customerAddress.findFirst({
            where: {
              id: destination.shippingAddressId,
              customerId,
              tenantId,
            },
          })
        : null;
      if (!address) {
        throw new ShippingQuoteError(
          'SHIPPING_ADDRESS_NOT_FOUND',
          'Shipping address not found for this customer',
        );
      }
      const zipCode = address.zipCode?.trim() ?? '';
      if (!/^\d{5}$/.test(zipCode)) {
        throw new ShippingQuoteError(
          'SHIPPING_ADDRESS_INCOMPLETE',
          'The saved address has no valid 5-digit postal code',
        );
      }
      return {
        source: 'ADDRESS',
        shippingAddressId: address.id,
        zipCode,
        state: address.state?.trim() || null,
        municipality: address.municipality?.trim() || null,
        neighborhood: address.neighborhood?.trim() || null,
      };
    }
    if (loose.some((value) => value === undefined)) throw invalidDestination();
    return {
      source: 'INPUT',
      shippingAddressId: null,
      zipCode: destination.zipCode!,
      state: destination.state!.trim(),
      municipality: destination.municipality!.trim(),
      neighborhood: destination.neighborhood!.trim(),
    };
  }

  /**
   * S9 — the chatbot catalog / sale rule: a stocked product sells its
   * quantity minus units in expired lots (lots exist only on non-variant
   * products); a variant sells its own quantity; untracked products never
   * lack stock. A line lacks stock when it asks for more than that.
   */
  private async lacksSellableStock(
    tenantId: string,
    lines: QuoteLine[],
    products: Map<string, ResolvedProduct>,
  ): Promise<boolean> {
    const client = this.tenantPrisma.getClient();
    const stocked = lines.filter(
      (line) => products.get(line.productId)!.useStock,
    );
    const variantIds = stocked.flatMap((line) =>
      line.variantId ? [line.variantId] : [],
    );
    const lotProductIds = stocked
      .filter(
        (line) => !line.variantId && !products.get(line.productId)!.hasVariants,
      )
      .map((line) => line.productId);
    const [variants, lots] = await Promise.all([
      client.variant.findMany({
        where: { tenantId, id: { in: variantIds } },
        select: { id: true, quantity: true },
      }),
      client.lot.findMany({
        where: {
          tenantId,
          productId: { in: lotProductIds },
          quantity: { gt: 0 },
        },
        select: { productId: true, quantity: true, expirationDate: true },
      }),
    ]);
    const today = businessToday(
      new Date(),
      this.configService.get<string>('PROMOTIONS_BUSINESS_TIMEZONE') ??
        'America/Mexico_City',
    );
    return stocked.some((line) => {
      const product = products.get(line.productId)!;
      if (line.variantId) {
        const variant = variants.find((v) => v.id === line.variantId);
        return (variant?.quantity ?? 0) < line.quantity;
      }
      const expired = sumExpiredLotQuantity(
        lots.filter((lot) => lot.productId === line.productId),
        today,
      );
      return sellableQuantity(product.quantity, expired) < line.quantity;
    });
  }
}

function assertOneLinePerItem(lines: QuoteLine[]): void {
  const keys = new Set(
    lines.map((line) => `${line.productId}::${line.variantId ?? ''}`),
  );
  if (keys.size !== lines.length) {
    // Same rule and code as pricing/evaluate-cart.
    throw new InvalidArgumentError(
      'Each product/variant must appear in only one cart line',
      'DUPLICATE_CART_LINE',
    );
  }
}

function invalidDestination(): ShippingQuoteError {
  return new ShippingQuoteError(
    'INVALID_SHIPPING_DESTINATION',
    'destination must be either shippingAddressId or zipCode, state, municipality and neighborhood',
  );
}

function noQuote(zoneStatus: 'DENIED' | 'PENDING'): ShippingQuoteResponse {
  return {
    quoteId: null,
    expiresAt: null,
    zoneStatus,
    option: null,
    eta: { days: null, reason: null },
    costCents: 0,
    creditCents: 0,
    customerChargeCents: 0,
    currency: 'MXN',
  };
}
