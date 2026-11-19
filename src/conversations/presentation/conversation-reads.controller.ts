/**
 * `GET /chatbot-requests/:id/conversation` (human-intervention unit 9; contract
 * §3.6, §3.8, §12.5). `JWT → tenant → active user → CASL`: the route needs
 * `read:ChatbotRequest`; the service then decides between the whole chat
 * (`read:ChatbotConversation`), the attendee's own session, or 403. Answers are
 * `no-store`. The ability comes from the guard-built `req.ability`, never from
 * the client.
 */
import {
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Query,
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
import { ChatbotRequestHttpFilter } from '../../chatbot-requests/presentation/chatbot-request-http.filter';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import {
  ConversationReadsService,
  type ConversationPageView,
} from '../application/conversation-reads.service';

type StaffRequest = Request & {
  user?: AuthenticatedUser;
  ability?: AppAbility;
};

@Controller('chatbot-requests')
@UseGuards(JwtAuthGuard, TenantContextGuard, ActiveUserGuard, PermissionsGuard)
@UseFilters(ChatbotRequestHttpFilter)
export class ConversationReadsController {
  constructor(private readonly reads: ConversationReadsService) {}

  @Get(':id/conversation')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(['read', 'ChatbotRequest'])
  conversation(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: Record<string, unknown>,
    @Req() req: StaffRequest,
  ): Promise<ConversationPageView> {
    const { user, ability } = req;
    // The guards always set both; a missing one means the context was lost.
    if (!user || !ability) throw new Error('staff context missing');
    return this.reads.page({ userId: user.userId, ability }, id, query);
  }
}
