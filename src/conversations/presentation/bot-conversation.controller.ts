/**
 * Bot routes of the conversation mirror (human-intervention unit 9; contract
 * §3.6, §3.9). The guard supplies the tenant (CLS) and the credential; nothing
 * about either is read from the path or the body. Both routes need the
 * `conversation:write` scope and spend from the `write` budget (R2). Every
 * answer, error included, is `no-store`.
 *
 * `@Body()` is typed `unknown` so the global pipe skips it: the service owns
 * validation (exact parser, untrusted text).
 *
 *   POST /chatbot-api/conversations/:conversationRef/messages:batch
 *   POST /chatbot-api/messages/statuses:batch
 *
 * The literal colon of `:batch` is escaped in the route (`\\:`), otherwise the
 * router reads it as a parameter.
 */
import {
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { RequiredScopes } from '../../chatbot-api/presentation/decorators/required-scopes.decorator';
import { BotRouteClass } from '../../chatbot-api/presentation/guards/route-class';
import { ServiceAuthGuard } from '../../chatbot-api/presentation/guards/service-auth.guard';
import { BOT_SCOPES } from '../../chatbot-requests/domain/bot-scopes';
import { ChatbotRequestHttpFilter } from '../../chatbot-requests/presentation/chatbot-request-http.filter';
import {
  ConversationMirrorService,
  type IngestResult,
  type StatusResult,
} from '../application/conversation-mirror.service';

@Controller('chatbot-api')
@UseGuards(ServiceAuthGuard)
@UseFilters(ChatbotRequestHttpFilter)
@BotRouteClass('write')
@RequiredScopes(BOT_SCOPES.conversationWrite)
export class BotConversationController {
  constructor(private readonly mirror: ConversationMirrorService) {}

  @Post('conversations/:conversationRef/messages\\:batch')
  @HttpCode(200)
  messages(
    @Param('conversationRef') conversationRef: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<IngestResult> {
    response.setHeader('Cache-Control', 'no-store');
    return this.mirror.ingest({ conversationRef, body });
  }

  @Post('messages/statuses\\:batch')
  @HttpCode(200)
  statuses(
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StatusResult> {
    response.setHeader('Cache-Control', 'no-store');
    return this.mirror.statuses({ body });
  }
}
