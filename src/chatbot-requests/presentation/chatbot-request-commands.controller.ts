/**
 * Staff commands on a chatbot request (contract §3.8, §3.10, §12.11, §12.12):
 *
 *   POST /chatbot-requests/:id/claim     read + update:ChatbotRequest
 *   POST /chatbot-requests/:id/release   read + update:ChatbotRequest
 *   POST /chatbot-requests/:id/cancel    read + update:ChatbotRequest
 *   POST /chatbot-requests/:id/reply     read + update:ChatbotRequest (the
 *                                        state machine requires the assignee)
 *   POST /chatbot-requests/:id/finish    read + update:ChatbotRequest (assignee,
 *                                        or a reassigner: forced finish, unit 11)
 *   POST /chatbot-requests/:id/reassign  read:ChatbotRequest +
 *                                        update:ChatbotRequestAssignment
 *   POST /chatbot-requests/:id/resolve   read + update:ChatbotRequest, and the
 *                                        legacy permission of the subtype
 *                                        (checked by the service once the row
 *                                        is loaded: domain/resolve-permissions)
 *   GET  /chatbot-requests/:id/zone-impact  read:ChatbotRequest
 *
 * Releasing or cancelling someone else's request also needs
 * `update:ChatbotRequestAssignment`; that comes from the guard-built ability
 * (`actorCanReassign`) and the state machine decides. The actor comes only
 * from the JWT. Every route takes `Idempotency-Key` and `expectedVersion`, and
 * answers `200 {request}` for a first run and a replay alike.
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
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { RequirePermissions } from '../../auth/authorization/decorators/require-permissions.decorator';
import type { AppAbility } from '../../auth/authorization/domain/permission';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { ActiveUserGuard } from '../../auth/guards/active-user.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import {
  ChatbotRequestCommandsService,
  type ChatbotRequestView,
  type StaffCommand,
} from '../application/chatbot-request-commands.service';
import {
  CancelDto,
  ExpectedVersionDto,
  FinishDto,
  IdempotencyKey,
  ReassignDto,
  ReplyDto,
} from './chatbot-request-commands.dto';
import { ChatbotRequestHttpFilter } from './chatbot-request-http.filter';
import { parseReplyText } from '../domain/clarification-reply';
import { parseFinishNote } from '../domain/live-session';
import { canResolveSubtype } from '../domain/resolve-permissions';
import { parseResolveBody } from './chatbot-request-resolve.body';

type StaffRequest = Request & {
  user?: AuthenticatedUser;
  ability?: AppAbility;
};

@Controller('chatbot-requests')
@UseGuards(JwtAuthGuard, TenantContextGuard, ActiveUserGuard, PermissionsGuard)
@UseFilters(ChatbotRequestHttpFilter)
export class ChatbotRequestCommandsController {
  constructor(private readonly commands: ChatbotRequestCommandsService) {}

  @Post(':id/claim')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(['read', 'ChatbotRequest'], ['update', 'ChatbotRequest'])
  claim(
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() key: string,
    @Body() body: ExpectedVersionDto,
    @Req() req: StaffRequest,
  ) {
    return this.run(req, id, key, body.expectedVersion, { kind: 'claim' });
  }

  @Post(':id/release')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(['read', 'ChatbotRequest'], ['update', 'ChatbotRequest'])
  release(
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() key: string,
    @Body() body: ExpectedVersionDto,
    @Req() req: StaffRequest,
  ) {
    return this.run(req, id, key, body.expectedVersion, { kind: 'release' });
  }

  @Post(':id/reassign')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(
    ['read', 'ChatbotRequest'],
    ['update', 'ChatbotRequestAssignment'],
  )
  reassign(
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() key: string,
    @Body() body: ReassignDto,
    @Req() req: StaffRequest,
  ) {
    return this.run(req, id, key, body.expectedVersion, {
      kind: 'reassign',
      toUserId: body.toUserId,
      note: body.note,
    });
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(['read', 'ChatbotRequest'], ['update', 'ChatbotRequest'])
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() key: string,
    @Body() body: CancelDto,
    @Req() req: StaffRequest,
  ) {
    return this.run(req, id, key, body.expectedVersion, {
      kind: 'cancel',
      reason: body.reason,
      note: body.note,
      customerNote: body.customerNote,
    });
  }

  /** Unit 10: answer a clarification; closes it and feeds the bot (§3.8). */
  @Post(':id/reply')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(['read', 'ChatbotRequest'], ['update', 'ChatbotRequest'])
  reply(
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() key: string,
    @Body() body: ReplyDto,
    @Req() req: StaffRequest,
  ) {
    return this.run(req, id, key, body.expectedVersion, {
      kind: 'reply',
      text: parseReplyText(body.text),
    });
  }

  /**
   * Unit 11 (§4.8): finish a live conversation. The assignee, or a reassigner
   * who forces it (`actorCanReassign`); the state machine decides.
   */
  @Post(':id/finish')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(['read', 'ChatbotRequest'], ['update', 'ChatbotRequest'])
  finish(
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() key: string,
    @Body() body: FinishDto,
    @Req() req: StaffRequest,
  ) {
    return this.run(req, id, key, body.expectedVersion, {
      kind: 'finish',
      note: parseFinishNote(body.note),
      complaintOutcome: body.complaintOutcome,
    });
  }

  /**
   * Flat body per subtype (§12.6). The wrapped use case gets the
   * Idempotency-Key as its own resolution id and `expectedVersion = 1` (R4).
   */
  @Post(':id/resolve')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(['read', 'ChatbotRequest'], ['update', 'ChatbotRequest'])
  resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() key: string,
    @Body() raw: unknown,
    @Req() req: StaffRequest,
  ) {
    const { expectedVersion, action } = parseResolveBody(raw, key);
    return this.run(req, id, key, expectedVersion, { kind: 'resolve', action });
  }

  /** What approving or rejecting the zone would settle (R9, §3.8). */
  @Get(':id/zone-impact')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(['read', 'ChatbotRequest'])
  zoneImpact(@Param('id', ParseUUIDPipe) id: string) {
    return this.commands.zoneImpact(id);
  }

  private async run(
    req: StaffRequest,
    requestId: string,
    idempotencyKey: string,
    expectedVersion: number,
    command: StaffCommand,
  ): Promise<{ request: ChatbotRequestView }> {
    // Fail closed if a guard was bypassed: no ability, no command.
    if (!req.user || !req.ability) throw new ForbiddenException();
    const { ability } = req;
    const request = await this.commands.execute({
      requestId,
      actorUserId: req.user.userId,
      actorCanReassign: ability.can('update', 'ChatbotRequestAssignment'),
      actorIsSuperAdmin: req.user.isSuperAdmin === true,
      actorCanResolveSubtype: (subtype) => canResolveSubtype(ability, subtype),
      idempotencyKey,
      expectedVersion,
      command,
    });
    return { request };
  }
}
