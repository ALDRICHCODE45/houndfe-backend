/**
 * Bot routes of the restock backorder contract (v1 §6). `ServiceAuthGuard`
 * authenticates the `svc_` credential, pins the trusted tenant into CLS and
 * checks the route's scope; nothing about the tenant is read from the request.
 *
 * Schedule and cancel spend from the `write` budget, the reads from `read`
 * (own buckets, like the human-intervention routes). Every answer, error
 * included, is code-only and `Cache-Control: no-store`: a backorder changes
 * state by itself (queue position, reservation).
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
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { RequiredScopes } from '../../chatbot-api/presentation/decorators/required-scopes.decorator';
import { BotRouteClass } from '../../chatbot-api/presentation/guards/route-class';
import { ServiceAuthGuard } from '../../chatbot-api/presentation/guards/service-auth.guard';
import { ParseIdempotencyKeyPipe } from '../../chatbot-api/presentation/pipes/parse-idempotency-key.pipe';
import { BackordersBotService } from '../application/backorders-bot.service';
import { BackorderError } from '../domain/backorder-error';
import { BACKORDER_SCOPES } from '../domain/backorder-scopes';
import { toBackorderHttpError } from './backorder-http-error';
import {
  parseCancelBackorderRequest,
  parseCreateBackorderRequest,
  parseListBackordersQuery,
} from './backorder-request.parsers';
import type {
  BackorderBotEnvelope,
  BackorderBotListEnvelope,
} from './dto/backorder-bot.response';

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed id can never match a row: the same 404 as an unknown one. */
function backorderId(id: string): string {
  if (!UUID_SHAPE.test(id)) throw new BackorderError('BACKORDER_NOT_FOUND');
  return id;
}

@Controller('chatbot-api/backorders')
@UseGuards(ServiceAuthGuard)
export class BackordersBotController {
  constructor(private readonly backorders: BackordersBotService) {}

  /** `201` created; `200` when the same key and body already created it (§6.1). */
  @Post()
  @BotRouteClass('write')
  @RequiredScopes(BACKORDER_SCOPES.create)
  async create(
    @Body() body: unknown,
    @Headers('x-idempotency-key') rawKey: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<BackorderBotEnvelope> {
    response.setHeader('Cache-Control', 'no-store');
    try {
      const key = new ParseIdempotencyKeyPipe().transform(rawKey, {
        type: 'custom',
      });
      const result = await this.backorders.create(
        parseCreateBackorderRequest(body),
        key,
      );
      response.status(result.replayed ? 200 : 201);
      return { backorder: result.backorder };
    } catch (error) {
      throw toBackorderHttpError(error);
    }
  }

  /** `GET /chatbot-api/backorders?phoneCountryCode=&phone=&status=&updatedSince=` (§6.3). */
  @Get()
  @BotRouteClass('read')
  @RequiredScopes(BACKORDER_SCOPES.read)
  async list(
    @Query() query: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<BackorderBotListEnvelope> {
    response.setHeader('Cache-Control', 'no-store');
    try {
      return {
        items: await this.backorders.list(parseListBackordersQuery(query)),
      };
    } catch (error) {
      throw toBackorderHttpError(error);
    }
  }

  @Get(':id')
  @BotRouteClass('read')
  @RequiredScopes(BACKORDER_SCOPES.read)
  async findOne(
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<BackorderBotEnvelope> {
    response.setHeader('Cache-Control', 'no-store');
    try {
      return { backorder: await this.backorders.findById(backorderId(id)) };
    } catch (error) {
      throw toBackorderHttpError(error);
    }
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @BotRouteClass('write')
  @RequiredScopes(BACKORDER_SCOPES.cancel)
  async cancel(
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<BackorderBotEnvelope> {
    response.setHeader('Cache-Control', 'no-store');
    try {
      const { reason } = parseCancelBackorderRequest(body);
      return {
        backorder: await this.backorders.cancel(backorderId(id), reason),
      };
    } catch (error) {
      throw toBackorderHttpError(error);
    }
  }
}
