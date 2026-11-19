/**
 * `POST /chatbot-api/media` (human-intervention unit 9; contract §3.6, §3.9):
 * the bot uploads a customer's image, sticker, PDF or audio BEFORE mirroring the
 * message that carries it. Multipart: the `file` part, plus an optional
 * `sha256` field the backend checks. `X-Idempotency-Key` is required (a
 * lowercase uuid). Scope `media:write`, `write` budget. `201` stores, `200`
 * replays. Never returns a storage key or a URL. Every answer is `no-store`.
 *
 * `GET /chatbot-api/media/:id` (unit 11, S16 9): the bot downloads the file of a
 * STAFF image/PDF message. Scope `media:read`, `read` budget; `no-store`.
 * Only a file a staff message carries is served (404 for unknown, other tenant,
 * purged, or a customer's file).
 *
 * Multer aborts the stream once the file passes 10 MB (`413 MEDIA_TOO_LARGE`,
 * mapped by `BotMediaHttpFilter`); the global body parser is not involved in
 * multipart.
 */
import {
  type ArgumentsHost,
  Catch,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  PayloadTooLargeException,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
  Body,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { RequiredScopes } from '../../chatbot-api/presentation/decorators/required-scopes.decorator';
import { BotRouteClass } from '../../chatbot-api/presentation/guards/route-class';
import { ServiceAuthGuard } from '../../chatbot-api/presentation/guards/service-auth.guard';
import { ChatbotRequestCommandError } from '../../chatbot-requests/application/chatbot-request-commands.service';
import { BOT_SCOPES } from '../../chatbot-requests/domain/bot-scopes';
import { ChatbotRequestHttpFilter } from '../../chatbot-requests/presentation/chatbot-request-http.filter';
import {
  ConversationMediaService,
  type MediaUploadView,
} from '../application/conversation-media.service';
import { CONVERSATION_MEDIA_MAX_BYTES } from '../domain/conversation-media';

/** Multer's file-size abort is a `PayloadTooLargeException`: name it for the bot. */
@Catch()
export class BotMediaHttpFilter extends ChatbotRequestHttpFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    super.catch(
      exception instanceof PayloadTooLargeException
        ? new ChatbotRequestCommandError('MEDIA_TOO_LARGE', 413)
        : exception,
      host,
    );
  }
}

@Controller('chatbot-api/media')
@UseGuards(ServiceAuthGuard)
@UseFilters(BotMediaHttpFilter)
@BotRouteClass('write')
export class BotMediaController {
  constructor(private readonly media: ConversationMediaService) {}

  @Post()
  @RequiredScopes(BOT_SCOPES.mediaWrite)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        // busboy flags a file that REACHES the limit as truncated, so the limit
        // sits one byte above the cap: exactly 10 MB passes, 10 MB + 1 aborts.
        fileSize: CONVERSATION_MEDIA_MAX_BYTES + 1,
        files: 1,
        fields: 4,
        fieldSize: 1024,
      },
    }),
  )
  async upload(
    @Headers('x-idempotency-key') idempotencyKey: string | undefined,
    // Untyped on purpose: the global ValidationPipe skips plain objects and the
    // service validates the fields strictly.
    @Body() fields: unknown,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MediaUploadView> {
    response.setHeader('Cache-Control', 'no-store');
    const { created, media } = await this.media.upload({
      idempotencyKey,
      file: file?.buffer,
      fields,
    });
    response.status(created ? 201 : 200);
    return media;
  }

  @Get(':id')
  @RequiredScopes(BOT_SCOPES.mediaRead)
  @BotRouteClass('read')
  async download(
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const file = await this.media.openForBot(id);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    // The stored name is already sanitized (ASCII, no quotes or separators).
    const name = file.filename ?? 'archivo';
    return new StreamableFile(file.body, {
      type: file.mimeType,
      disposition: `attachment; filename="${name}"`,
      ...(file.contentLength !== null ? { length: file.contentLength } : {}),
    });
  }
}
