/**
 * shipping-zones / T3 — POST /chatbot-api/shipping/quotes (docs/shipping-quotes.md).
 *
 * Service auth with the dedicated scope `shipping:quote`. Every failure leaves
 * as an HttpException with a stable `error` code, so the bot audit log records
 * the real status. Unexpected failures become a fixed 500: a raw driver
 * message could echo the customer phone or address.
 */
import {
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  BusinessRuleViolationError,
  DomainError,
  EntityNotFoundError,
  InvalidArgumentError,
} from '../../shared/domain/domain-error';
import { ShippingQuoteError } from '../../shipping/quotes/domain/shipping-quote.errors';
import { ShippingQuoteService } from '../application/shipping-quote.service';
import { RequiredScopes } from './decorators/required-scopes.decorator';
import { ShippingQuoteRequestDto } from './dto/shipping-quote.request';
import { ServiceAuthGuard } from './guards/service-auth.guard';
import { BotAuditInterceptor } from './interceptors/bot-audit.interceptor';

const STATUS_BY_CODE: Record<string, number> = {
  INVALID_SHIPPING_DESTINATION: HttpStatus.BAD_REQUEST,
  PRODUCT_NOT_FOUND: HttpStatus.NOT_FOUND,
  VARIANT_NOT_FOUND: HttpStatus.NOT_FOUND,
  SHIPPING_ADDRESS_NOT_FOUND: HttpStatus.NOT_FOUND,
  CUSTOMER_NOT_FOUND: HttpStatus.NOT_FOUND,
  CUSTOMER_PHONE_AMBIGUOUS: HttpStatus.CONFLICT,
  PRICE_OUT_OF_DATE: HttpStatus.CONFLICT,
  SHIPPING_ADDRESS_INCOMPLETE: HttpStatus.UNPROCESSABLE_ENTITY,
  SHIPPING_ORIGIN_NOT_CONFIGURED: HttpStatus.UNPROCESSABLE_ENTITY,
  PACKAGING_DATA_MISSING: HttpStatus.UNPROCESSABLE_ENTITY,
  NO_SHIPPING_BOX_FITS: HttpStatus.UNPROCESSABLE_ENTITY,
  SHIPPING_QUOTE_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
};

function statusOf(error: DomainError): number {
  const mapped = STATUS_BY_CODE[error.code];
  if (mapped) return mapped;
  if (error instanceof EntityNotFoundError) return HttpStatus.NOT_FOUND;
  if (error instanceof InvalidArgumentError) return HttpStatus.BAD_REQUEST;
  return HttpStatus.UNPROCESSABLE_ENTITY;
}

export function toShippingQuoteHttpError(error: unknown): HttpException {
  if (error instanceof HttpException) return error;
  if (error instanceof DomainError) {
    const status = statusOf(error);
    const details =
      error instanceof BusinessRuleViolationError ||
      error instanceof ShippingQuoteError
        ? error.details
        : undefined;
    return new HttpException(
      {
        ...details,
        statusCode: status,
        error: error.code,
        message: error.message,
      },
      status,
    );
  }
  return new HttpException(
    {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'SHIPPING_QUOTE_FAILED',
      message: 'SHIPPING_QUOTE_FAILED',
    },
    HttpStatus.INTERNAL_SERVER_ERROR,
  );
}

@Controller('chatbot-api/shipping')
@UseGuards(ServiceAuthGuard)
@UseInterceptors(BotAuditInterceptor)
export class ShippingQuotesController {
  constructor(private readonly quotes: ShippingQuoteService) {}

  @Post('quotes')
  @RequiredScopes('shipping:quote')
  async quote(@Body() body: ShippingQuoteRequestDto) {
    try {
      return await this.quotes.quote({
        phoneCountryCode: body.phoneCountryCode,
        phone: body.phone,
        items: body.items.map((item) => ({
          productId: item.productId,
          variantId: item.variantId ?? null,
          quantity: item.quantity,
        })),
        destination: body.destination,
      });
    } catch (error) {
      throw toShippingQuoteHttpError(error);
    }
  }
}
