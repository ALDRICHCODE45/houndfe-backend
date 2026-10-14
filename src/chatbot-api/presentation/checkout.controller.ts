import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  CheckoutService,
  checkoutError,
} from '../application/checkout.service';
import {
  DomainError,
  InvalidArgumentError,
} from '../../shared/domain/domain-error';
import { RequiredScopes } from './decorators/required-scopes.decorator';
import {
  CheckoutRequestDto,
  ExistingCheckoutAddressDto,
} from './dto/checkout.request';
import { ParseIdempotencyKeyPipe } from './pipes/parse-idempotency-key.pipe';
import { ServiceAuthGuard } from './guards/service-auth.guard';
import { BotAuditInterceptor } from './interceptors/bot-audit.interceptor';

const CONFLICTS = new Set([
  'CUSTOMER_PHONE_AMBIGUOUS',
  'ADDRESS_VERSION_CONFLICT',
  'IDEMPOTENCY_KEY_CONFLICT',
  'IDEMPOTENCY_KEY_IN_FLIGHT',
  'PRICE_OUT_OF_DATE',
  'PROMO_RE_QUOTE',
  'STOCK_INSUFFICIENT_AT_CONFIRM',
  'SHIPPING_APPROVAL_ALREADY_USED',
  'PROMO_CAPACITY_RE_QUOTE',
  'PROMOTION_CAPACITY_EXCEEDED',
  'PROMOTION_CAPACITY_CLAIM_MISMATCH',
]);
const MISSING = new Set([
  'CUSTOMER_NOT_FOUND',
  'SHIPPING_ADDRESS_NOT_FOUND',
  'CASHIER_NOT_FOUND',
  'SELLER_NOT_FOUND',
]);

/** New boundary only: never persist or return raw driver/domain message/details. */
function safeError(error: unknown): HttpException {
  if (error instanceof DomainError && /^[A-Z][A-Z_]{1,79}$/.test(error.code)) {
    const status = CONFLICTS.has(error.code)
      ? 409
      : MISSING.has(error.code)
        ? 404
        : error instanceof InvalidArgumentError
          ? 400
          : 422;
    return checkoutError(status, error.code);
  }
  if (error instanceof HttpException) {
    const payload = error.getResponse();
    if (
      typeof payload === 'object' &&
      payload !== null &&
      'error' in payload &&
      'message' in payload &&
      payload.error === payload.message &&
      typeof payload.error === 'string' &&
      /^[A-Z][A-Z_]{1,79}$/.test(payload.error)
    ) {
      return checkoutError(error.getStatus(), payload.error);
    }
  }
  return checkoutError(500, 'CHECKOUT_CREATE_FAILED');
}

function parseRequest(value: unknown): CheckoutRequestDto {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw checkoutError(400, 'INVALID_CHECKOUT_REQUEST');
  let dto: CheckoutRequestDto;
  try {
    dto = plainToInstance(CheckoutRequestDto, value);
    if (
      validateSync(dto, {
        whitelist: true,
        forbidNonWhitelisted: true,
        forbidUnknownValues: true,
      }).length
    )
      throw new Error('invalid');
    if (
      dto.sale.items.some(
        (item) =>
          !Number.isSafeInteger(item.quantity) ||
          !Number.isSafeInteger(item.unitPriceCents) ||
          item.unitPriceCents > 2_147_483_647,
      )
    )
      throw new Error('invalid');
    if (
      dto.deliveryAddress instanceof ExistingCheckoutAddressDto &&
      new Date(dto.deliveryAddress.expectedVersion).toISOString() !==
        dto.deliveryAddress.expectedVersion
    )
      throw new Error('invalid');
  } catch {
    throw checkoutError(400, 'INVALID_CHECKOUT_REQUEST');
  }
  return dto;
}

@Controller('chatbot-api/checkouts')
@UseGuards(ServiceAuthGuard)
@UseInterceptors(BotAuditInterceptor)
@RequiredScopes('customers:write', 'sales:create')
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  @Post()
  async create(
    @Body() body: unknown,
    @Headers('x-idempotency-key') rawKey: unknown,
  ) {
    try {
      const key = new ParseIdempotencyKeyPipe().transform(rawKey, {
        type: 'custom',
      });
      return await this.checkout.create(parseRequest(body), key);
    } catch (error) {
      throw safeError(error);
    }
  }

  @Get('status')
  async status(@Headers('x-idempotency-key') rawKey: unknown) {
    try {
      const key = new ParseIdempotencyKeyPipe().transform(rawKey, {
        type: 'custom',
      });
      return await this.checkout.status(key);
    } catch (error) {
      throw safeError(error);
    }
  }
}
