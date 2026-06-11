import {
  Post,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Body,
  Query,
  UseGuards,
  Headers,
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

@Controller('chatbot-api')
@UseGuards(ServiceAuthGuard)
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
}
