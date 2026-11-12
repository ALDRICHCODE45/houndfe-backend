/**
 * Error envelope of the chatbot settings routes: the staff envelope of
 * `ChatbotRequestHttpFilter` (`{statusCode, code, message}`) plus
 * - 409 `VERSION_CONFLICT` with `current`, the settings a GET would return
 *   (omitted when the caller has no `read:ChatbotSettings`: apply-to-all);
 * - 400 `VALIDATION_ERROR` with `reason`, the domain code (`INVALID_OPENING_HOURS`,
 *   `INVALID_CHATBOT_SETTINGS`) and the domain message, which is fixed text
 *   written by this codebase and never echoes input.
 * Everything else is delegated to the staff filter unchanged.
 */
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import { ChatbotRequestHttpFilter } from '../../chatbot-requests/presentation/chatbot-request-http.filter';
import { SettingsVersionConflictError } from '../application/chatbot-settings.service';

@Catch()
export class ChatbotSettingsHttpFilter implements ExceptionFilter {
  private readonly staff = new ChatbotRequestHttpFilter();

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (exception instanceof SettingsVersionConflictError) {
      response.setHeader('Cache-Control', 'no-store');
      response.status(HttpStatus.CONFLICT).json({
        statusCode: HttpStatus.CONFLICT,
        code: 'VERSION_CONFLICT',
        message: 'The settings changed; reload them',
        ...(exception.current ? { current: exception.current } : {}),
      });
      return;
    }
    if (exception instanceof InvalidArgumentError) {
      response.setHeader('Cache-Control', 'no-store');
      response.status(HttpStatus.BAD_REQUEST).json({
        statusCode: HttpStatus.BAD_REQUEST,
        code: 'VALIDATION_ERROR',
        reason: exception.code,
        message: exception.message,
      });
      return;
    }
    this.staff.catch(exception, host);
  }
}
