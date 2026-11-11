/**
 * Bot recovery route (unit 5, slice 5c; contract §3.3, §3.9): the way back
 * after `410 CURSOR_EXPIRED`. Scope `requests:read`, route class `read`; the
 * guard supplies the tenant (CLS) and the credential, and nothing about either
 * is read from the query. Every answer, error included, is `no-store`.
 */
import {
  Controller,
  Get,
  Query,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { RequiredScopes } from '../../chatbot-api/presentation/decorators/required-scopes.decorator';
import { BotRouteClass } from '../../chatbot-api/presentation/guards/route-class';
import { ServiceAuthGuard } from '../../chatbot-api/presentation/guards/service-auth.guard';
import {
  ChatbotRecoveryService,
  type RecoveryAnswer,
} from '../application/chatbot-recovery.service';
import { BOT_SCOPES } from '../domain/bot-scopes';
import { ChatbotRequestHttpFilter } from './chatbot-request-http.filter';

@Controller('chatbot-api')
@UseGuards(ServiceAuthGuard)
@UseFilters(ChatbotRequestHttpFilter)
export class BotRecoveryController {
  constructor(private readonly recovery: ChatbotRecoveryService) {}

  /** `GET /chatbot-api/requests?status=open&updatedSince=&cursor=&limit=50` */
  @Get('requests')
  @BotRouteClass('read')
  @RequiredScopes(BOT_SCOPES.requestsRead)
  recover(
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<RecoveryAnswer> {
    response.setHeader('Cache-Control', 'no-store');
    return this.recovery.recover(query);
  }
}
