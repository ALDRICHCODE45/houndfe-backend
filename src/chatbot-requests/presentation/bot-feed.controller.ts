/**
 * Bot feed routes (unit 5, slice 5b; contract §3.3, §3.9, §4.5). The guard
 * supplies the tenant (CLS) and the credential; nothing about either is read
 * from the query or the body. The long-poll spends from the `feed` budget once,
 * when it opens (R2); the outcome spends from `write`, the pending list from
 * `read`. Every answer, error included, is `no-store`.
 *
 * `@Body()` is typed `unknown` so the global pipe skips it: the service owns
 * validation (exact parser).
 */
import {
  Body,
  Controller,
  Get,
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
  ChatbotFeedService,
  type FeedItemView,
  type OutcomeAck,
} from '../application/chatbot-feed.service';
import { parseFeedQuery } from '../domain/chatbot-feed';
import { BOT_SCOPES } from '../domain/bot-scopes';
import { ChatbotRequestHttpFilter } from './chatbot-request-http.filter';

interface ServiceAuthenticatedRequest extends Request {
  serviceCredential?: { id: string; tenantId: string };
}

@Controller('chatbot-api')
@UseGuards(ServiceAuthGuard)
@UseFilters(ChatbotRequestHttpFilter)
export class BotFeedController {
  constructor(private readonly feed: ChatbotFeedService) {}

  private credential(request: ServiceAuthenticatedRequest) {
    // The guard always sets it; a missing value means the trusted context was
    // lost, so deny rather than serve an unknown caller.
    const credential = request.serviceCredential;
    if (!credential)
      throw new UnauthorizedException('Service credential required');
    return credential;
  }

  /** `GET /chatbot-api/feed?after=&limit=50&waitSeconds=25` */
  @Get('feed')
  @BotRouteClass('feed')
  @RequiredScopes(BOT_SCOPES.feedRead)
  async read(
    @Query() query: Record<string, unknown>,
    @Req() request: ServiceAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ items: FeedItemView[]; nextCursor: string }> {
    const credential = this.credential(request);
    response.setHeader('Cache-Control', 'no-store');
    const { after, limit, waitSeconds } = parseFeedQuery(query);
    // A client that hangs up frees its slot and its waiter at once. `close`
    // on the response, not the request: Node also closes the request once its
    // (empty) body was read.
    const disconnected = new AbortController();
    response.on('close', () => {
      if (!response.writableFinished) disconnected.abort();
    });
    return this.feed.poll({
      tenantId: credential.tenantId,
      credentialId: credential.id,
      after,
      limit,
      waitSeconds,
      signal: disconnected.signal,
    });
  }

  /**
   * `GET /chatbot-api/requests/pending-deliveries?conversationRef=` (§4.5), or
   * `?requestId=` for a request that has no conversationRef (one of the two).
   */
  @Get('requests/pending-deliveries')
  @BotRouteClass('read')
  @RequiredScopes(BOT_SCOPES.feedRead)
  pending(
    @Query() query: Record<string, unknown>,
    @Req() request: ServiceAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ items: FeedItemView[] }> {
    this.credential(request);
    response.setHeader('Cache-Control', 'no-store');
    return this.feed.pending({
      conversationRef: query.conversationRef,
      requestId: query.requestId,
    });
  }

  /** `POST /chatbot-api/deliveries/:deliveryId/outcome` (§3.3) */
  @Post('deliveries/:deliveryId/outcome')
  @HttpCode(200)
  @BotRouteClass('write')
  @RequiredScopes(BOT_SCOPES.feedAck)
  outcome(
    @Param('deliveryId') deliveryId: string,
    @Body() body: unknown,
    @Req() request: ServiceAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OutcomeAck> {
    const credential = this.credential(request);
    response.setHeader('Cache-Control', 'no-store');
    return this.feed.outcome({
      deliveryId,
      credentialId: credential.id,
      body,
    });
  }
}
