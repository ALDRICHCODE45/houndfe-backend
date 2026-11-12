/**
 * `GET /chatbot-media/:id[?variant=thumb]` (human-intervention unit 9; contract
 * §3.6, §12.5): the authenticated proxy for a conversation file. No signed or
 * public URL exists: a signed URL would outlive a revoked permission or a
 * deactivated user, so the permission and `isActive` are checked on EVERY read
 * (`JWT → tenant → active user → CASL`) and the bytes stream through the
 * backend. Needs `read:ChatbotRequest` plus `read:ChatbotConversation`, or (live
 * session exception of §12.5, unit 11) being the attendee of a request whose
 * session's messages carry the file.
 *
 * The browser gets the real type, `inline`, `private, no-store`, `nosniff`, and
 * a CSP that sandboxes anything active inside the file. A PDF carries a generic
 * file name (never one the customer chose).
 */
import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  Res,
  StreamableFile,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AppAbility } from '../../auth/authorization/domain/permission';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { InsufficientPermissionsError } from '../../shared/domain/domain-error';
import { RequirePermissions } from '../../auth/authorization/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { ActiveUserGuard } from '../../auth/guards/active-user.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { ChatbotRequestHttpFilter } from '../../chatbot-requests/presentation/chatbot-request-http.filter';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { ConversationMediaService } from '../application/conversation-media.service';

type StaffRequest = Request & {
  user?: AuthenticatedUser;
  ability?: AppAbility;
};

@Controller('chatbot-media')
@UseGuards(JwtAuthGuard, TenantContextGuard, ActiveUserGuard, PermissionsGuard)
@UseFilters(ChatbotRequestHttpFilter)
export class ConversationMediaController {
  constructor(private readonly media: ConversationMediaService) {}

  @Get(':id')
  @RequirePermissions(['read', 'ChatbotRequest'])
  async read(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('variant') variant: unknown,
    @Req() req: StaffRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const { user, ability } = req;
    if (!user || !ability) throw new Error('staff context missing');
    // Unit 11 (§12.5 live session exception): without `read:ChatbotConversation`
    // the attendee opens only the files of THEIR session's messages.
    if (
      !ability.can('read', 'ChatbotConversation') &&
      !(await this.media.attendeeSeesMedia(id, user.userId))
    ) {
      throw new InsufficientPermissionsError();
    }
    const file = await this.media.open(id, variant);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; sandbox",
    );
    return new StreamableFile(file.body, {
      type: file.mimeType,
      disposition:
        file.mimeType === 'application/pdf'
          ? 'inline; filename="documento.pdf"'
          : 'inline',
      ...(file.contentLength !== null ? { length: file.contentLength } : {}),
    });
  }
}
