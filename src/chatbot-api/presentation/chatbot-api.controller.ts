import {
  Post,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Patch,
  Body,
  Query,
  UseGuards,
  HttpCode,
  Headers,
  UseInterceptors,
  HttpStatus,
} from '@nestjs/common';
import { ChatbotApiService } from '../application/chatbot-api.service';
import { RequiredScopes } from './decorators/required-scopes.decorator';
import { CatalogSearchQueryDto } from './dto/catalog-search.query';
import { EvaluateCartRequestDto } from './dto/evaluate-cart.request';
import {
  CustomerPhoneLookupQueryDto,
  CustomerUpsertRequestDto,
} from './dto/customer-upsert.request';
import { ServiceAuthGuard } from './guards/service-auth.guard';
import { RegisterBotSaleRequestDto } from './dto/register-bot-sale.request';
import { AttachReceiptRequestDto } from './dto/attach-receipt.request';
import { DeliveryMetadataRequestDto } from './dto/delivery-metadata.request';
import { CancelBotSaleRequestDto } from './dto/cancel-bot-sale.request';
import { BotAuditInterceptor } from './interceptors/bot-audit.interceptor';

@Controller('chatbot-api')
@UseGuards(ServiceAuthGuard)
@UseInterceptors(BotAuditInterceptor)
@RequiredScopes('catalog:read')
export class ChatbotApiController {
  constructor(private readonly chatbotApiService: ChatbotApiService) {}

  @Get('catalog/search')
  searchCatalog(@Query() query: CatalogSearchQueryDto) {
    return this.chatbotApiService.searchCatalog({
      q: query.q,
      limit: query.limit,
    });
  }

  @Get('catalog/:productId/stock')
  checkStock(@Param('productId', ParseUUIDPipe) productId: string) {
    return this.chatbotApiService.checkStock(productId);
  }

  @Post('pricing/evaluate-cart')
  @RequiredScopes('pricing:evaluate')
  evaluateCart(@Body() body: EvaluateCartRequestDto) {
    return this.chatbotApiService.evaluateCart({
      items: body.items.map((item) => ({
        productId: item.productId,
        variantId: item.variantId ?? null,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
      })),
    });
  }

  @Get('customers/by-phone')
  @RequiredScopes('customers:read')
  findCustomerByPhone(@Query() query: CustomerPhoneLookupQueryDto) {
    return this.chatbotApiService.findCustomerByPhone({
      phoneCountryCode: query.phoneCountryCode,
      phone: query.phone,
    });
  }

  @Put('customers/by-phone')
  @RequiredScopes('customers:write')
  upsertCustomerProfile(@Body() body: CustomerUpsertRequestDto) {
    return this.chatbotApiService.upsertCustomerProfile(body);
  }

  // ── Bot Sale Routes ─────────────────────────────────────────────────────────

  @Post('sales')
  @RequiredScopes('sales:create')
  registerBotSale(
    @Body() body: RegisterBotSaleRequestDto,
    @Headers('x-idempotency-key') idempotencyKey: string,
  ) {
    return this.chatbotApiService.registerBotSale({
      cashierUserId: body.cashierUserId,
      customerId: body.customerId,
      shippingAddressId: body.shippingAddressId ?? null,
      items: body.items.map((item) => ({
        productId: item.productId,
        variantId: item.variantId ?? null,
        productName: item.productName,
        variantName: item.variantName ?? null,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
      })),
      idempotencyKey: idempotencyKey ?? '',
    });
  }

  @Post('sales/:saleId/receipts')
  @RequiredScopes('sales:write')
  attachReceipt(
    @Param('saleId', ParseUUIDPipe) saleId: string,
    @Body() body: AttachReceiptRequestDto,
  ) {
    return this.chatbotApiService.attachReceipt({
      saleId,
      mediaUrl: body.mediaUrl,
      declaredAmountCents: body.declaredAmountCents,
      declaredDate: body.declaredDate ? new Date(body.declaredDate) : null,
      declaredReference: body.declaredReference ?? null,
    });
  }

  @Patch('sales/:saleId/delivery')
  @HttpCode(200)
  @RequiredScopes('sales:write')
  async setDeliveryMetadata(
    @Param('saleId', ParseUUIDPipe) saleId: string,
    @Body() body: DeliveryMetadataRequestDto,
  ) {
    await this.chatbotApiService.setDeliveryMetadata({
      saleId,
      carrierName: body.carrierName ?? null,
      trackingRef: body.trackingRef ?? null,
      estimatedDeliveryAt: body.estimatedDeliveryAt
        ? new Date(body.estimatedDeliveryAt)
        : null,
    });
    return {};
  }

  @Get('customers/by-phone/:phone/orders')
  @RequiredScopes('customers:read')
  getOrderHistoryByPhone(
    @Param('phone') phone: string,
    @Query('phoneCountryCode') phoneCountryCode: string,
  ) {
    return this.chatbotApiService.getOrderHistoryByPhone({
      phoneCountryCode: phoneCountryCode ?? '',
      phone,
    });
  }

  /**
   * POST /chatbot-api/sales/:saleId/cancel — Cancel a bot sale.
   * Requires `sales:write` scope. Delegates to SalesService.cancelSale via ChatbotApiService.
   */
  @Post('sales/:saleId/cancel')
  @HttpCode(HttpStatus.OK)
  @RequiredScopes('sales:write')
  cancelBotSale(
    @Param('saleId', ParseUUIDPipe) saleId: string,
    @Body() body: CancelBotSaleRequestDto,
  ) {
    return this.chatbotApiService.cancelBotSale({
      saleId,
      reason: body.reason,
      cashierUserId: body.cashierUserId,
    });
  }
}
