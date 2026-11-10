/**
 * Controller-scoped error envelope for the chatbot-request staff routes
 * (§3.8): `{statusCode, code, message}`, plus `current {version, status,
 * claimedBy}` on typed command errors so the FE catches up without a reload.
 * Messages are fixed per code; nothing from the thrown value is echoed.
 */
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  InsufficientPermissionsError,
  InvalidArgumentError,
} from '../../shared/domain/domain-error';
import { ChatbotRequestCommandError } from '../application/chatbot-request-commands.service';

const MESSAGES: Record<string, string> = {
  VALIDATION_ERROR: 'Invalid request',
  UNAUTHORIZED: 'Unauthorized',
  FORBIDDEN: 'Forbidden',
  INSUFFICIENT_PERMISSIONS: 'Insufficient permissions',
  NOT_FOUND: 'Chatbot request not found',
  VERSION_CONFLICT: 'The request changed; reload it',
  REQUEST_CLAIMED_BY_OTHER: 'Another person already took this request',
  REQUEST_CLOSED: 'The request is already closed',
  NOT_ASSIGNEE: 'Only the assignee or a reassigner can do this',
  ACTION_NOT_ALLOWED: 'This action is not allowed in the current state',
  CANCEL_NOT_ALLOWED: 'This request cannot be cancelled now',
  IDEMPOTENCY_CONFLICT: 'Idempotency-Key was already used with another body',
  USER_NOT_ASSIGNABLE: 'The user cannot be assigned to chatbot requests',
  RATE_LIMITED: 'Too many requests',
  REQUEST_ERROR: 'Request failed',
  INTERNAL_ERROR: 'Internal server error',
};

const HTTP_CODES: Partial<Record<number, string>> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  429: 'RATE_LIMITED',
};

@Catch()
export class ChatbotRequestHttpFilter implements ExceptionFilter {
  private readonly logger = new Logger(ChatbotRequestHttpFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const body = this.toBody(exception);
    const name = exception instanceof Error ? exception.name : 'unknown';
    const line = `[${String(body.code)}] ${name}`;
    if (Number(body.statusCode) >= 500) this.logger.error(line);
    else this.logger.warn(line);
    host
      .switchToHttp()
      .getResponse<Response>()
      .setHeader('Cache-Control', 'no-store')
      .status(Number(body.statusCode))
      .json(body);
  }

  private toBody(exception: unknown): Record<string, unknown> {
    if (exception instanceof ChatbotRequestCommandError) {
      return {
        ...this.build(exception.httpStatus, exception.code),
        ...(exception.current ? { current: exception.current } : {}),
      };
    }
    if (exception instanceof InsufficientPermissionsError) {
      return this.build(HttpStatus.FORBIDDEN, 'INSUFFICIENT_PERMISSIONS');
    }
    if (exception instanceof InvalidArgumentError) {
      return this.build(HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR');
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code =
        HTTP_CODES[status] ??
        (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR');
      return this.build(status, code);
    }
    return this.build(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR');
  }

  private build(statusCode: number, code: string) {
    return { statusCode, code, message: MESSAGES[code] };
  }
}
