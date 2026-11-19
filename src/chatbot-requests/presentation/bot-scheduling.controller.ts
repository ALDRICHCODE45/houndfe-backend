/**
 * Bot routes of scheduled conversations (human-intervention unit 14; contract
 * "Scheduled conversations (unit 14)"). `ServiceAuthGuard` supplies the trusted
 * tenant (CLS) and the credential. Every answer, error included, is `no-store`.
 *
 *   GET  /chatbot-api/scheduling/slots?conversationRef=   `requests:read`, `read`
 *   POST /chatbot-api/requests/:id/reschedule             `requests:create`, `write`
 *
 * Bodies and queries are typed `unknown` so the global pipe skips them: the
 * service owns the exact parsers.
 */
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { RequiredScopes } from '../../chatbot-api/presentation/decorators/required-scopes.decorator';
import { BotRouteClass } from '../../chatbot-api/presentation/guards/route-class';
import { ServiceAuthGuard } from '../../chatbot-api/presentation/guards/service-auth.guard';
import {
  SchedulingService,
  type BotRescheduleResponse,
  type SlotsAnswer,
} from '../application/scheduling.service';
import { BOT_SCOPES } from '../domain/bot-scopes';
import { ChatbotRequestHttpFilter } from './chatbot-request-http.filter';

interface ServiceAuthenticatedRequest extends Request {
  serviceCredential?: { id: string };
}

@Controller('chatbot-api')
@UseGuards(ServiceAuthGuard)
@UseFilters(ChatbotRequestHttpFilter)
export class BotSchedulingController {
  constructor(private readonly scheduling: SchedulingService) {}

  @Get('scheduling/slots')
  @BotRouteClass('read')
  @RequiredScopes(BOT_SCOPES.requestsRead)
  slots(
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SlotsAnswer> {
    response.setHeader('Cache-Control', 'no-store');
    return this.scheduling.slots(query);
  }

  @Post('requests/:id/reschedule')
  @HttpCode(200)
  @BotRouteClass('write')
  @RequiredScopes(BOT_SCOPES.requestsCreate)
  reschedule(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('x-idempotency-key') idempotencyKey: string | undefined,
    @Req() request: ServiceAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<BotRescheduleResponse> {
    // The guard always sets it; a missing value means the trusted context
    // was lost, so deny rather than audit an unknown actor.
    const credentialId = request.serviceCredential?.id;
    if (!credentialId) {
      throw new UnauthorizedException('Service credential required');
    }
    response.setHeader('Cache-Control', 'no-store');
    return this.scheduling.botReschedule({
      credentialId,
      idempotencyKey,
      requestId: id,
      body,
    });
  }
}
