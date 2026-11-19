import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { SaleHoldService } from '../../sales/sale-hold.service';
import { RequiredScopes } from './decorators/required-scopes.decorator';
import { PaymentIntentRequestDto } from './dto/payment-intent.request';
import { ServiceAuthGuard } from './guards/service-auth.guard';
import { BotAuditInterceptor } from './interceptors/bot-audit.interceptor';

/**
 * pay-in-store-pickup / T1 (S1, S2, S6) — the bot declares that the customer
 * pays at the counter when picking up.
 *
 * A separate idempotent PATCH (not a checkout field) so POST
 * /chatbot-api/checkouts, its request hash and its cached receipts stay
 * untouched, and the intent can be declared after the sale exists (the
 * customer often chooses how to pay after the order is confirmed). Scope
 * `sales:write`, the same as the other post-sale bot writes (delivery
 * metadata, cancel, receipts).
 *
 * 200 `{ saleId, folio, paymentIntent, holdUntil, reminderAt }`. Errors are
 * code-only: 404 SALE_NOT_FOUND, 409 PAY_IN_STORE_SALE_NOT_CONFIRMED /
 * PAY_IN_STORE_SALE_ALREADY_PAID, 422 PAY_IN_STORE_REQUIRES_ONLINE /
 * PAY_IN_STORE_REQUIRES_PICKUP.
 */
@Controller('chatbot-api/sales')
@UseGuards(ServiceAuthGuard)
@UseInterceptors(BotAuditInterceptor)
@RequiredScopes('sales:write')
export class PayInStoreController {
  constructor(private readonly holds: SaleHoldService) {}

  @Patch(':saleId/payment-intent')
  @HttpCode(HttpStatus.OK)
  markPaymentIntent(
    @Param('saleId', ParseUUIDPipe) saleId: string,
    // Validated by the global pipe; `IN_STORE` is the only accepted method,
    // so the value itself carries nothing the service needs.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    @Body() _body: PaymentIntentRequestDto,
  ) {
    return this.holds.markPayInStore(saleId);
  }
}
