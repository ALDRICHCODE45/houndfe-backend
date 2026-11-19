/**
 * Bot routes of the human-intervention contract (unit 5, slice 5a; §3.2,
 * §3.4, §3.9). `ServiceAuthGuard` supplies the trusted tenant (CLS) and the
 * credential; nothing about either is read from the body. Both routes spend
 * from the `write` budget (R2). Every answer, error included, is `no-store`.
 *
 * `@Body()` is typed `unknown` so the global pipe sees metatype `Object` and
 * skips it: the service owns validation (exact parsers).
 */
import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Param,
  Post,
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
  BotRequestIntakeService,
  type BotCancelResponse,
  type BotCreateResponse,
} from '../application/bot-request-intake.service';
import { BOT_SCOPES } from '../domain/bot-scopes';
import { ChatbotRequestHttpFilter } from './chatbot-request-http.filter';

interface ServiceAuthenticatedRequest extends Request {
  serviceCredential?: { id: string };
}

const IDEMPOTENCY_HEADER = 'x-idempotency-key';

@Controller('chatbot-api/requests')
@UseGuards(ServiceAuthGuard)
@UseFilters(ChatbotRequestHttpFilter)
@BotRouteClass('write')
export class BotRequestsController {
  constructor(private readonly intake: BotRequestIntakeService) {}

  private credentialId(request: ServiceAuthenticatedRequest): string {
    // The guard always sets it; a missing value means the trusted context
    // was lost, so deny rather than audit an unknown actor.
    const id = request.serviceCredential?.id;
    if (!id) throw new UnauthorizedException('Service credential required');
    return id;
  }

  /** 201 created; 200 for a replay or a merge into an open request (§3.2). */
  @Post()
  @RequiredScopes(BOT_SCOPES.requestsCreate)
  async create(
    @Body() body: unknown,
    @Headers(IDEMPOTENCY_HEADER) idempotencyKey: string | undefined,
    @Req() request: ServiceAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<BotCreateResponse> {
    const credentialId = this.credentialId(request);
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.intake.create({
      credentialId,
      idempotencyKey,
      body,
    });
    response.status(result.httpStatus);
    return result.body;
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequiredScopes(BOT_SCOPES.requestsCancel)
  cancel(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers(IDEMPOTENCY_HEADER) idempotencyKey: string | undefined,
    @Req() request: ServiceAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<BotCancelResponse> {
    const credentialId = this.credentialId(request);
    response.setHeader('Cache-Control', 'no-store');
    return this.intake.cancel({
      credentialId,
      idempotencyKey,
      requestId: id,
      body,
    });
  }
}
