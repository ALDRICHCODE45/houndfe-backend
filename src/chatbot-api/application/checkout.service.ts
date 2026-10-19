import { HttpException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type CustomerAddress } from '@prisma/client';
import { createHash } from 'node:crypto';
import { SalesService } from '../../sales/sales.service';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  CheckoutRequestDto,
  ExistingCheckoutAddressDto,
  ExistingCheckoutCustomerDto,
  NewCheckoutAddressDto,
} from '../presentation/dto/checkout.request';
import type {
  CheckoutResponse,
  CheckoutStatusResponse,
} from '../presentation/dto/checkout.response';

export const CHECKOUT_OPERATION = 'bot_checkout_create';
const ADDRESS_FIELDS = [
  'label',
  'exteriorNumber',
  'interiorNumber',
  'zipCode',
  'neighborhood',
  'municipality',
  'city',
  'state',
  'visualReferences',
  'carrierPhone',
] as const;

/** New-route errors contain codes only, including when the audit interceptor sees them. */
export function checkoutError(statusCode: number, code: string): HttpException {
  return new HttpException(
    { statusCode, error: code, message: code },
    statusCode,
  );
}

/** Full intent hash: unlike legacy sale hashes, display names and all address fields count. */
export function computeCheckoutRequestHash(input: CheckoutRequestDto): string {
  const customer =
    input.customer instanceof ExistingCheckoutCustomerDto
      ? { mode: 'existing', customerId: input.customer.customerId }
      : {
          mode: 'createIfAbsent',
          firstName: input.customer.firstName,
          lastName: input.customer.lastName ?? null,
        };
  const address =
    input.deliveryAddress instanceof ExistingCheckoutAddressDto
      ? {
          mode: 'existing',
          addressId: input.deliveryAddress.addressId,
          expectedVersion: input.deliveryAddress.expectedVersion,
        }
      : {
          mode: 'newSaved',
          address: normalizedAddress(input.deliveryAddress.address),
        };
  return createHash('sha256')
    .update(
      JSON.stringify({
        phoneCountryCode: input.phoneCountryCode,
        phone: input.phone,
        customer,
        deliveryAddress: address,
        sale: {
          cashierUserId: input.sale.cashierUserId,
          items: input.sale.items.map((item) => ({
            productId: item.productId,
            variantId: item.variantId ?? null,
            productName: item.productName,
            variantName: item.variantName ?? null,
            quantity: item.quantity,
            unitPriceCents: item.unitPriceCents,
          })),
          expectedTotalCents: input.sale.expectedTotalCents,
          shipping: input.sale.shipping
            ? {
                chargeCents: input.sale.shipping.chargeCents,
                approvalId: input.sale.shipping.approvalId.trim(),
                quoteId: input.sale.shipping.quoteId?.trim() ?? null,
              }
            : null,
        },
      }),
    )
    .digest('hex');
}

function normalizedAddress(address: NewCheckoutAddressDto['address']) {
  return {
    street: address.street,
    ...Object.fromEntries(
      ADDRESS_FIELDS.map((field) => [field, address[field] ?? null]),
    ),
  } as { street: string } & Record<
    (typeof ADDRESS_FIELDS)[number],
    string | null
  >;
}

function cachedResponse(value: Prisma.JsonValue | null): CheckoutResponse {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.status !== 'created' ||
    !value.customer ||
    !value.address ||
    !value.sale
  ) {
    throw checkoutError(500, 'CHECKOUT_CREATE_FAILED');
  }
  // SAFETY: this tenant-scoped operation writes the complete validated CheckoutResponse
  // atomically with the sale; JsonValue cannot express the response interface.
  return value as unknown as CheckoutResponse;
}

@Injectable()
export class CheckoutService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly salesService: SalesService,
    private readonly config: ConfigService,
  ) {}

  async status(key: string): Promise<CheckoutStatusResponse> {
    const tenantId = this.tenantPrisma.getTenantId();
    const receipt = await this.tenantPrisma
      .getClient()
      .saleIdempotency.findUnique({
        where: {
          tenantId_operation_key: {
            tenantId,
            operation: CHECKOUT_OPERATION,
            key,
          },
        },
      });
    if (!receipt || receipt.status !== 'SUCCEEDED')
      return { status: 'not_observed', checkout: null };
    return {
      status: 'succeeded',
      checkout: cachedResponse(receipt.responseJson),
    };
  }

  async create(
    input: CheckoutRequestDto,
    key: string,
  ): Promise<CheckoutResponse> {
    const tenantId = this.tenantPrisma.getTenantId();
    const requestHash = computeCheckoutRequestHash(input);
    const identity = { tenantId, operation: CHECKOUT_OPERATION, key };
    try {
      return await this.tenantPrisma.runInTransaction(async () => {
        const tx = this.tenantPrisma.getClient();
        // Separate namespaces prevent key/phone lock collisions from lock-order inversion.
        const lock = JSON.stringify(['bot_checkout_key', tenantId, key]);
        const acquired = await tx.$queryRaw<Array<{ acquired: boolean }>>`
          SELECT pg_try_advisory_xact_lock(hashtextextended(${lock}, 0)) AS acquired
        `;
        if (!acquired[0]?.acquired)
          throw checkoutError(409, 'IDEMPOTENCY_KEY_IN_FLIGHT');
        const receipt = await tx.saleIdempotency.findUnique({
          where: { tenantId_operation_key: identity },
        });
        if (receipt) {
          if (receipt.requestHash !== requestHash)
            throw checkoutError(409, 'IDEMPOTENCY_KEY_CONFLICT');
          if (receipt.status !== 'SUCCEEDED')
            throw checkoutError(409, 'IDEMPOTENCY_KEY_IN_FLIGHT');
          return cachedResponse(receipt.responseJson);
        }

        const shipping = this.validateShipping(input);
        const membership = await tx.tenantMembership.findFirst({
          where: { tenantId, userId: input.sale.cashierUserId },
          select: { id: true },
        });
        if (!membership) throw checkoutError(404, 'CASHIER_NOT_FOUND');

        // All NEW checkout writers serialize the zero-row lookup, even with different keys.
        // Legacy/admin writers are intentionally not given a new uniqueness contract.
        const phoneLock = JSON.stringify([
          'bot_checkout_phone',
          tenantId,
          input.phoneCountryCode,
          input.phone,
        ]);
        await tx.$queryRaw(
          // pg_advisory_xact_lock returns void; cast only its result to a supported scalar.
          Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${phoneLock}, 0))::text`,
        );
        const where = {
          tenantId,
          phoneCountryCode: input.phoneCountryCode,
          phone: input.phone,
        };
        let matches = await tx.customer.findMany({ where, take: 2 });
        if (matches.length > 1)
          throw checkoutError(409, 'CUSTOMER_PHONE_AMBIGUOUS');
        let customer = matches[0];
        const customerResolution = customer ? 'existing' : 'created';
        if (customer) {
          // Protect the matched row from deletion/phone/profile changes during this order.
          await tx.$queryRaw(
            Prisma.sql`SELECT id FROM customers WHERE id = ${customer.id} AND "tenantId" = ${tenantId} FOR UPDATE`,
          );
          matches = await tx.customer.findMany({ where, take: 2 });
          if (matches.length > 1)
            throw checkoutError(409, 'CUSTOMER_PHONE_AMBIGUOUS');
          customer = matches.find((row) => row.id === customer.id)!;
          if (!customer) throw checkoutError(404, 'CUSTOMER_NOT_FOUND');
        }
        if (input.customer instanceof ExistingCheckoutCustomerDto) {
          if (!customer || customer.id !== input.customer.customerId)
            throw checkoutError(404, 'CUSTOMER_NOT_FOUND');
        } else if (!customer) {
          customer = await tx.customer.create({
            data: {
              tenantId,
              phoneCountryCode: input.phoneCountryCode,
              phone: input.phone,
              firstName: input.customer.firstName,
              lastName: input.customer.lastName ?? null,
            },
          });
        }

        let address: CustomerAddress | null;
        const addressResolution =
          input.deliveryAddress instanceof ExistingCheckoutAddressDto
            ? 'existing'
            : 'created';
        if (input.deliveryAddress instanceof ExistingCheckoutAddressDto) {
          const addressId = input.deliveryAddress.addressId;
          await tx.$queryRaw(
            Prisma.sql`SELECT id FROM customer_addresses WHERE id = ${addressId} AND "tenantId" = ${tenantId} AND "customerId" = ${customer.id} FOR UPDATE`,
          );
          address = await tx.customerAddress.findUnique({
            where: { id: addressId, tenantId, customerId: customer.id },
          });
          if (!address) throw checkoutError(404, 'SHIPPING_ADDRESS_NOT_FOUND');
          if (
            address.updatedAt.toISOString() !==
            input.deliveryAddress.expectedVersion
          )
            throw checkoutError(409, 'ADDRESS_VERSION_CONFLICT');
        } else {
          address = await tx.customerAddress.create({
            data: {
              tenantId,
              customerId: customer.id,
              ...normalizedAddress(input.deliveryAddress.address),
            },
          });
        }
        const sale = await this.salesService.confirmBotSale({
          cashierUserId: input.sale.cashierUserId,
          customerId: customer.id,
          shippingAddressId: address.id,
          items: input.sale.items,
          expectedTotalCents: input.sale.expectedTotalCents,
          // Match the not_found quote even though the customer now has an ID.
          ...(customerResolution === 'created'
            ? { excludeRegisteredOnlyPromotions: true }
            : {}),
          ...(shipping ? { shipping } : {}),
        });
        const response: CheckoutResponse = {
          status: 'created',
          customer: {
            resolution: customerResolution,
            customerId: customer.id,
            firstName: customer.firstName,
            lastName: customer.lastName,
          },
          address: {
            resolution: addressResolution,
            id: address.id,
            version: address.updatedAt.toISOString(),
          },
          sale,
        };
        // No independently committed IN_FLIGHT and no post-commit success stamp.
        await tx.saleIdempotency.create({
          data: {
            ...identity,
            requestHash,
            status: 'SUCCEEDED',
            saleId: sale.saleId,
            // SAFETY: all CheckoutResponse members are strings/numbers/null/plain objects;
            // sale timestamps are ISO strings, not Date instances or undefined values.
            responseJson: response as unknown as Prisma.InputJsonValue,
          },
        });
        return response;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2002') {
          // PostgreSQL aborted the transaction: this read is deliberately OUTSIDE it.
          const receipt = await this.tenantPrisma
            .getClient()
            .saleIdempotency.findUnique({
              where: { tenantId_operation_key: identity },
            });
          if (receipt) {
            if (receipt.requestHash !== requestHash)
              throw checkoutError(409, 'IDEMPOTENCY_KEY_CONFLICT');
            if (receipt.status === 'SUCCEEDED')
              return cachedResponse(receipt.responseJson);
            throw checkoutError(409, 'IDEMPOTENCY_KEY_IN_FLIGHT');
          }
        }
        if (['P2034', 'P2028', 'P2024'].includes(error.code))
          throw checkoutError(503, 'CHECKOUT_RETRY_REQUIRED');
      }
      throw error;
    }
  }

  private validateShipping(input: CheckoutRequestDto) {
    const shipping = input.sale.shipping;
    if (!shipping) return undefined;
    const maximum = this.config.get<number>('BOT_SHIPPING_CHARGE_MAX_CENTS');
    if (!Number.isSafeInteger(maximum) || !maximum || maximum <= 0)
      throw checkoutError(422, 'SHIPPING_CHARGE_UNAVAILABLE');
    if (shipping.chargeCents > maximum)
      throw checkoutError(422, 'SHIPPING_CHARGE_EXCEEDS_MAX');
    if (input.sale.expectedTotalCents <= 0)
      throw checkoutError(422, 'SHIPPING_EXPECTED_TOTAL_REQUIRED');
    return {
      chargeCents: shipping.chargeCents,
      approvalId: shipping.approvalId.trim(),
      ...(shipping.quoteId !== undefined
        ? { quoteId: shipping.quoteId.trim() }
        : {}),
    };
  }
}
