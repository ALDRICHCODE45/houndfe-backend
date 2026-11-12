/**
 * Live conversation routes (human-intervention unit 11; contract §4.3, §4.4,
 * §4.7, §3.9, §3.10).
 *
 * Staff (JWT + tenant + active user + `read` and `update:ChatbotRequest`):
 *   POST /chatbot-requests/:id/messages   {clientMessageId, expectedEpoch, text}
 *        `Idempotency-Key` MUST equal `clientMessageId` (§12.12).
 * Bot (`svc_` credential; the tenant comes from the guard):
 *   POST /chatbot-api/conversations/:conversationRef/session-ack  `conversation:write`, `control`
 *   GET  /chatbot-api/conversations/:conversationRef/state        `requests:read`, `read`
 *
 * `@Body()` of the bot route is `unknown`: the exact parser below owns the
 * validation (no other key is accepted).
 */
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { RequirePermissions } from '../../auth/authorization/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { ActiveUserGuard } from '../../auth/guards/active-user.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { RequiredScopes } from '../../chatbot-api/presentation/decorators/required-scopes.decorator';
import { BotRouteClass } from '../../chatbot-api/presentation/guards/route-class';
import { ServiceAuthGuard } from '../../chatbot-api/presentation/guards/service-auth.guard';
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { ChatbotRequestCommandError } from '../application/chatbot-request-commands.service';
import { BOT_SCOPES } from '../domain/bot-scopes';
import { parseStaffMessageText } from '../domain/live-session';
import {
  PrismaLiveConversationStore,
  type SessionAckResult,
  type StaffMessageResult,
} from '../infrastructure/prisma-live-conversation.store';
import {
  IdempotencyKey,
  StaffMessageDto,
} from './chatbot-request-commands.dto';
import { ChatbotRequestHttpFilter } from './chatbot-request-http.filter';

const REF = /^[A-Za-z0-9:_.@+-]{1,200}$/;

function parseRef(raw: string): string {
  if (!REF.test(raw)) {
    throw new InvalidArgumentError(
      'Invalid conversationRef',
      'VALIDATION_ERROR',
    );
  }
  return raw;
}

/** Exactly `{epoch, state, providerMessageId?}` (bot contract, session-ack). */
export function parseSessionAck(raw: unknown): {
  epoch: number;
  state: 'STARTED' | 'ENDED';
} {
  const bad = (): never => {
    throw new InvalidArgumentError('Invalid session-ack', 'VALIDATION_ERROR');
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) bad();
  const body = raw as Record<string, unknown>;
  const allowed = new Set(['epoch', 'state', 'providerMessageId']);
  if (Object.keys(body).some((key) => !allowed.has(key))) bad();
  const { epoch, state, providerMessageId } = body;
  if (
    typeof epoch !== 'number' ||
    !Number.isInteger(epoch) ||
    epoch < 1 ||
    epoch > 2_147_483_647
  ) {
    bad();
  }
  if (state !== 'STARTED' && state !== 'ENDED') bad();
  if (
    providerMessageId !== undefined &&
    (typeof providerMessageId !== 'string' ||
      providerMessageId.length < 1 ||
      providerMessageId.length > 512 ||
      providerMessageId !== providerMessageId.trim())
  ) {
    bad();
  }
  return { epoch: epoch as number, state: state as 'STARTED' | 'ENDED' };
}

type StaffRequest = Request & { user?: AuthenticatedUser };

@Controller('chatbot-requests')
@UseGuards(JwtAuthGuard, TenantContextGuard, ActiveUserGuard, PermissionsGuard)
@UseFilters(ChatbotRequestHttpFilter)
export class LiveConversationStaffController {
  constructor(private readonly store: PrismaLiveConversationStore) {}

  @Post(':id/messages')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(['read', 'ChatbotRequest'], ['update', 'ChatbotRequest'])
  async send(
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() key: string,
    @Body() body: StaffMessageDto,
    @Req() req: StaffRequest,
  ): Promise<StaffMessageResult> {
    if (!req.user) throw new ForbiddenException();
    if (key !== body.clientMessageId.toLowerCase()) {
      throw new InvalidArgumentError(
        'Idempotency-Key must equal clientMessageId',
        'VALIDATION_ERROR',
      );
    }
    return this.store.sendStaffMessage({
      requestId: id,
      actorUserId: req.user.userId,
      clientMessageId: body.clientMessageId.toLowerCase(),
      expectedEpoch: body.expectedEpoch,
      text: parseStaffMessageText(body.text),
      // The paid-template command is not part of the first slice of unit 11.
      templateAllowed: false,
    });
  }
}

@Controller('chatbot-api')
@UseGuards(ServiceAuthGuard)
@UseFilters(ChatbotRequestHttpFilter)
export class BotLiveConversationController {
  constructor(private readonly store: PrismaLiveConversationStore) {}

  @Post('conversations/:conversationRef/session-ack')
  @HttpCode(HttpStatus.OK)
  @BotRouteClass('control')
  @RequiredScopes(BOT_SCOPES.conversationWrite)
  sessionAck(
    @Param('conversationRef') conversationRef: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionAckResult> {
    response.setHeader('Cache-Control', 'no-store');
    const ack = parseSessionAck(body);
    return this.store.sessionAck(
      parseRef(conversationRef),
      ack.epoch,
      ack.state,
    );
  }

  @Get('conversations/:conversationRef/state')
  @BotRouteClass('read')
  @RequiredScopes(BOT_SCOPES.requestsRead)
  async state(
    @Param('conversationRef') conversationRef: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const state = await this.store.conversationState(parseRef(conversationRef));
    if (!state) throw new ChatbotRequestCommandError('NOT_FOUND', 404);
    return state;
  }
}
