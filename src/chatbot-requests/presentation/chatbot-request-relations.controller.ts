/**
 * Staff commands that relate a request to another request or to a customer
 * (contract §3.8, §3.10, §12.11, §12.12; unit 4, slice 4b):
 *
 *   POST /chatbot-requests/:id/merge          read + update:ChatbotRequest
 *   POST /chatbot-requests/:id/link-customer  read + update:ChatbotRequest
 *
 * §3.10 gives both the same permission as the other commands; link-customer
 * does not need `read:CustomerPhone`: the user picks among the candidates of
 * the detail (phones masked for them) and the server proves the phone match.
 * Same guards, headers and `200 {request}` as the commands of slice 2b.
 */
import {
  Body,
  Controller,
  ForbiddenException,
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
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { ActiveUserGuard } from '../../auth/guards/active-user.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { ChatbotRequestRelationsService } from '../application/chatbot-request-relations.service';
import {
  IdempotencyKey,
  LinkCustomerDto,
  MergeDto,
} from './chatbot-request-commands.dto';
import { ChatbotRequestHttpFilter } from './chatbot-request-http.filter';

type StaffRequest = Request & { user?: AuthenticatedUser };

@Controller('chatbot-requests')
@UseGuards(JwtAuthGuard, TenantContextGuard, ActiveUserGuard, PermissionsGuard)
@UseFilters(ChatbotRequestHttpFilter)
export class ChatbotRequestRelationsController {
  constructor(private readonly relations: ChatbotRequestRelationsService) {}

  @Post(':id/merge')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(['read', 'ChatbotRequest'], ['update', 'ChatbotRequest'])
  async merge(
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() key: string,
    @Body() body: MergeDto,
    @Req() req: StaffRequest,
  ) {
    const request = await this.relations.merge({
      requestId: id,
      actorUserId: this.actor(req),
      idempotencyKey: key,
      expectedVersion: body.expectedVersion,
      intoRequestId: body.intoRequestId,
      intoExpectedVersion: body.intoExpectedVersion,
    });
    return { request };
  }

  @Post(':id/link-customer')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(['read', 'ChatbotRequest'], ['update', 'ChatbotRequest'])
  async linkCustomer(
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() key: string,
    @Body() body: LinkCustomerDto,
    @Req() req: StaffRequest,
  ) {
    const request = await this.relations.linkCustomer({
      requestId: id,
      actorUserId: this.actor(req),
      idempotencyKey: key,
      expectedVersion: body.expectedVersion,
      customerId: body.customerId,
    });
    return { request };
  }

  /** The actor comes only from the JWT; fail closed if a guard was bypassed. */
  private actor(req: StaffRequest): string {
    if (!req.user) throw new ForbiddenException();
    return req.user.userId;
  }
}
