/**
 * `GET /chatbot-media/:id[?variant=thumb]` (human-intervention unit 9; contract
 * §3.6, §12.5): the authenticated proxy for a conversation file. No signed or
 * public URL exists: a signed URL would outlive a revoked permission or a
 * deactivated user, so the permission and `isActive` are checked on EVERY read
 * (`JWT → tenant → active user → CASL`) and the bytes stream through the
 * backend. Needs `read:ChatbotRequest` and `read:ChatbotConversation` (the live
 * session exception of §12.5 arrives with unit 11).
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
  Res,
  StreamableFile,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { RequirePermissions } from '../../auth/authorization/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { ActiveUserGuard } from '../../auth/guards/active-user.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { ChatbotRequestHttpFilter } from '../../chatbot-requests/presentation/chatbot-request-http.filter';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { ConversationMediaService } from '../application/conversation-media.service';

@Controller('chatbot-media')
@UseGuards(JwtAuthGuard, TenantContextGuard, ActiveUserGuard, PermissionsGuard)
@UseFilters(ChatbotRequestHttpFilter)
export class ConversationMediaController {
  constructor(private readonly media: ConversationMediaService) {}

  @Get(':id')
  @RequirePermissions(
    ['read', 'ChatbotRequest'],
    ['read', 'ChatbotConversation'],
  )
  async read(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('variant') variant: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
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
