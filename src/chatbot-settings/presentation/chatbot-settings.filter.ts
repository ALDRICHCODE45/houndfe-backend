/**
 * Error envelope of the chatbot settings routes: the staff envelope of
 * `ChatbotRequestHttpFilter` (`{statusCode, code, message}`) plus
 * - 409 `VERSION_CONFLICT` with `current`, the settings a GET would return
 *   (omitted when the caller has no `read:ChatbotSettings`: apply-to-all);
 * - 400 `VALIDATION_ERROR` with `reason`, the domain code (`INVALID_OPENING_HOURS`,
 *   `INVALID_CHATBOT_SETTINGS`) and the domain message, which is fixed text
 *   written by this codebase and never echoes input;
 * - every 400 `VALIDATION_ERROR` of a body (rule or shape) adds `fieldErrors`,
 *   `[{path, code}]` with JSON-path-like paths and stable codes (S11).
 * Everything else is delegated to the staff filter unchanged.
 */
import {
  type ArgumentsHost,
  BadRequestException,
  Catch,
  type ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import { ChatbotRequestHttpFilter } from '../../chatbot-requests/presentation/chatbot-request-http.filter';
import { SettingsVersionConflictError } from '../application/chatbot-settings.service';
import { SettingsValidationError } from '../domain/chatbot-settings-validation';
import {
  fieldErrorsOfValidation,
  validationErrorsOf,
} from './chatbot-settings-field-errors';

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
        fieldErrors:
          exception instanceof SettingsValidationError
            ? exception.fieldErrors
            : [],
      });
      return;
    }
    const shape =
      exception instanceof BadRequestException
        ? validationErrorsOf(exception.getResponse())
        : null;
    if (shape) {
      const request = host.switchToHttp().getRequest<{ body?: object }>();
      response.setHeader('Cache-Control', 'no-store');
      response.status(HttpStatus.BAD_REQUEST).json({
        statusCode: HttpStatus.BAD_REQUEST,
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
        fieldErrors: fieldErrorsOfValidation(shape, request.body),
      });
      return;
    }
    this.staff.catch(exception, host);
  }
}
