/**
 * HD-03a — route-scoped sanitized HTTP filter for human-decision routes.
 *
 * Approved design (read-only):
 * `houndfe-chatbot-human-decisions/docs/human-decisions-contract-v1.md`.
 *
 * The global filters (`DomainExceptionFilter`, `PrismaExceptionFilter`) emit
 * a different envelope (`error`/`timestamp`, sometimes a raw validation
 * array) and MUST NOT change for existing APIs. RESTOCK bot/human routes
 * instead apply this filter at controller level so every thrown value —
 * including `ServiceAuthGuard` and pipe/`ValidationPipe` exceptions — is
 * reduced to the EXACT contract shape:
 *
 *   { statusCode: number, code: string, message: string }
 *
 * No `error`, no `timestamp`, no raw validation array, no request payload,
 * credential, tenant, UUID or upstream message is ever echoed. `@Catch()`
 * with no arguments is intentional: controller-scoped application makes this
 * the catch-all for the route while global behavior stays untouched.
 *
 * Mapping:
 *   RestockIntakeError NOT_FOUND                              -> 404 NOT_FOUND
 *   RestockIntakeError IDEMPOTENCY_CONFLICT/VERSION_CONFLICT  -> 409 (same code)
 *   InvalidArgumentError / BadRequestException / ValidationPipe -> 400 VALIDATION_ERROR
 *   ForbiddenException                                        -> 403 FORBIDDEN
 *   UnauthorizedException                                     -> 401 UNAUTHORIZED
 *   HttpException 429                                         -> 429 RATE_LIMITED
 *     (the guard-set `Retry-After` response header is left untouched)
 *   other HttpException 4xx                                   -> retained status, REQUEST_ERROR
 *   other HttpException 5xx                                   -> retained status, INTERNAL_ERROR
 *   anything else                                             -> 500 INTERNAL_ERROR
 */
import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Response } from 'express';
import { InvalidArgumentError } from '../../../shared/domain/domain-error';
import { RestockIntakeError } from '../../domain/restock-intake.repository';

/** Sanitized machine codes the human-decision envelope can emit. */
export type HumanDecisionErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'VERSION_CONFLICT'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'REQUEST_ERROR'
  | 'INTERNAL_ERROR';

/** The exact three-key RESTOCK error contract. */
export interface HumanDecisionErrorBody {
  statusCode: number;
  code: HumanDecisionErrorCode;
  message: string;
}

/**
 * Fixed, value-free messages. Nothing here is derived from the thrown
 * exception, so an upstream message or payload can never leak.
 */
const FIXED_MESSAGES: Record<HumanDecisionErrorCode, string> = {
  VALIDATION_ERROR: 'Invalid request',
  UNAUTHORIZED: 'Unauthorized',
  FORBIDDEN: 'Forbidden',
  NOT_FOUND: 'Not found',
  IDEMPOTENCY_CONFLICT: 'Request conflicts with a previous submission',
  VERSION_CONFLICT: 'Human decision was modified by another reviewer',
  CONFLICT: 'Request conflict',
  RATE_LIMITED: 'Too many requests',
  REQUEST_ERROR: 'Request failed',
  INTERNAL_ERROR: 'Internal server error',
};

@Catch()
export class HumanDecisionHttpFilter implements ExceptionFilter {
  private readonly logger = new Logger(HumanDecisionHttpFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const body = this.toErrorBody(exception);

    this.log(exception, body);

    response.status(body.statusCode).json(body);
  }

  private toErrorBody(exception: unknown): HumanDecisionErrorBody {
    if (exception instanceof RestockIntakeError) {
      return this.fromIntakeError(exception);
    }

    if (
      exception instanceof InvalidArgumentError ||
      exception instanceof BadRequestException
    ) {
      return this.build(HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR');
    }

    if (exception instanceof UnauthorizedException) {
      return this.build(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED');
    }

    if (exception instanceof ForbiddenException) {
      return this.build(HttpStatus.FORBIDDEN, 'FORBIDDEN');
    }

    if (exception instanceof HttpException) {
      return this.fromHttpException(exception);
    }

    return this.build(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR');
  }

  private fromIntakeError(error: RestockIntakeError): HumanDecisionErrorBody {
    switch (error.code) {
      case 'NOT_FOUND':
        return this.build(HttpStatus.NOT_FOUND, 'NOT_FOUND');
      case 'IDEMPOTENCY_CONFLICT':
        return this.build(HttpStatus.CONFLICT, 'IDEMPOTENCY_CONFLICT');
      case 'VERSION_CONFLICT':
        return this.build(HttpStatus.CONFLICT, 'VERSION_CONFLICT');
      default:
        return this.build(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR');
    }
  }

  /**
   * Keeps the original HTTP status (sanitized) for any other NestJS
   * exception, including unmapped 4xx/5xx values. 5xx always collapses to
   * the generic INTERNAL_ERROR code and message so an upstream gateway or
   * provider failure cannot leak through; 4xx keeps a stable request code.
   */
  private fromHttpException(exception: HttpException): HumanDecisionErrorBody {
    const status = exception.getStatus() as HttpStatus;
    return this.build(status, this.codeForHttpStatus(status));
  }

  private codeForHttpStatus(status: HttpStatus): HumanDecisionErrorCode {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return 'VALIDATION_ERROR';
      case HttpStatus.UNAUTHORIZED:
        return 'UNAUTHORIZED';
      case HttpStatus.FORBIDDEN:
        return 'FORBIDDEN';
      case HttpStatus.NOT_FOUND:
        return 'NOT_FOUND';
      case HttpStatus.CONFLICT:
        return 'CONFLICT';
      case HttpStatus.TOO_MANY_REQUESTS:
        return 'RATE_LIMITED';
      default:
        return status >= HttpStatus.INTERNAL_SERVER_ERROR
          ? 'INTERNAL_ERROR'
          : 'REQUEST_ERROR';
    }
  }

  private build(
    statusCode: number,
    code: HumanDecisionErrorCode,
  ): HumanDecisionErrorBody {
    return { statusCode, code, message: FIXED_MESSAGES[code] };
  }

  /** Server-side log with the code and exception class name only. */
  private log(exception: unknown, body: HumanDecisionErrorBody): void {
    const name = exception instanceof Error ? exception.name : typeof exception;
    const line = `[${body.code}] ${name}`;

    if (body.statusCode >= 500) {
      this.logger.error(line);
    } else {
      this.logger.warn(line);
    }
  }
}
