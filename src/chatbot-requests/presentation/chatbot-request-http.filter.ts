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
  INSUFFICIENT_SCOPE: 'The credential lacks the scope for this route',
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
  MERGE_NOT_ALLOWED: 'These requests cannot be merged',
  CUSTOMER_PHONE_MISMATCH:
    'The customer phone does not match the request phone',
  ZONE_SET_CHANGED: 'The customers waiting on this zone changed; review again',
  ALREADY_RESOLVED: 'The request was already resolved',
  CUSTOMER_OPEN_LIMIT: 'The customer has too many open requests',
  CUSTOMER_RATE_LIMITED: 'Too many requests were created for this customer',
  SUBTYPE_DISABLED: 'This subtype cannot be created through this route',
  SCHEDULING_DISABLED: 'Scheduled conversations are not available yet',
  RATE_LIMITED: 'Too many requests',
  CURSOR_EXPIRED: 'The cursor is older than the feed retention',
  OUTCOME_ALREADY_RECORDED:
    'A different terminal outcome was already recorded for this delivery',
  OUTCOME_NOT_ALLOWED: 'This outcome is not allowed for this delivery',
  RANGE_TOO_LARGE: 'The date range is longer than 92 days',
  BATCH_TOO_LARGE: 'Too many items in one call',
  MESSAGE_ID_CONFLICT:
    'A message id of this batch already belongs to another conversation',
  REPLY_NOT_FOUND:
    'A staffReplyId does not match a staff reply of this conversation',
  MEDIA_NOT_FOUND: 'A referenced media file does not exist',
  MEDIA_TYPE_MISMATCH: 'The media file does not match the message type',
  MEDIA_TOO_LARGE: 'The file is larger than 10 MB',
  MEDIA_TYPE_NOT_ALLOWED: 'This file type is not allowed',
  MEDIA_PURGED: 'The file was deleted by the retention policy',
  THUMB_UNAVAILABLE: 'This file has no thumbnail',
  MEDIA_STORAGE_FAILED: 'The file could not be stored or read, retry later',
  SESSION_NOT_ACTIVE: 'The live session is not active',
  STALE_EPOCH: 'The handoff epoch is not the current one',
  SESSION_NOT_ENDING: 'The session is not ending: only the backend ends it',
  WINDOW_CLOSED: 'The 24 h WhatsApp window is closed',
  WINDOW_OPEN:
    'The 24 h WhatsApp window is open: write a message instead of a template',
  TEMPLATE_ALREADY_SENT: 'The template was already requested for this window',
  TEMPLATE_NOT_CONFIGURED: 'No WhatsApp template is configured',
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
    const { retryAfterSeconds, ...publicBody } = body;
    const name = exception instanceof Error ? exception.name : 'unknown';
    const line = `[${String(body.code)}] ${name}`;
    if (Number(body.statusCode) >= 500) this.logger.error(line);
    else this.logger.warn(line);
    const response = host.switchToHttp().getResponse<Response>();
    response.setHeader('Cache-Control', 'no-store');
    if (typeof retryAfterSeconds === 'number') {
      response.setHeader('Retry-After', String(retryAfterSeconds));
    }
    response.status(Number(body.statusCode)).json(publicBody);
  }

  private toBody(exception: unknown): Record<string, unknown> {
    if (exception instanceof ChatbotRequestCommandError) {
      return {
        ...this.build(exception.httpStatus, exception.code),
        ...(exception.current ? { current: exception.current } : {}),
        ...exception.extra,
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
      // The bot guard's own message for a missing scope (§3.9).
      if (
        Number(status) === Number(HttpStatus.FORBIDDEN) &&
        exception.message === 'Insufficient service scope'
      ) {
        return this.build(status, 'INSUFFICIENT_SCOPE');
      }
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
