import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ChatbotApiService } from '../application/chatbot-api.service';
import { RequiredScopes } from './decorators/required-scopes.decorator';
import { CatalogSearchQueryDto } from './dto/catalog-search.query';
import {
  CustomerPhoneLookupQueryDto,
  CustomerUpsertRequestDto,
} from './dto/customer-upsert.request';
import { ServiceAuthGuard } from './guards/service-auth.guard';

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
}
