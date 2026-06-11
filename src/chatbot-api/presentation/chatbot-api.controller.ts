import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ChatbotApiService } from '../application/chatbot-api.service';
import { RequiredScopes } from './decorators/required-scopes.decorator';
import { CatalogSearchQueryDto } from './dto/catalog-search.query';
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
}
