/**
 * shipping-zones / T1 — controller-scoped filter for the store delivery-zone
 * routes. Only `DeliveryZoneError` and the zone-shape `InvalidArgumentError`
 * are caught; every other exception keeps the global filters. The body is the
 * fixed `{statusCode, code, message}` envelope; the message never echoes input.
 */
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import {
  DeliveryZoneError,
  type DeliveryZoneErrorCode,
} from '../domain/delivery-zone.repository';

const STATUS: Record<DeliveryZoneErrorCode, HttpStatus> = {
  DELIVERY_ZONE_NOT_FOUND: HttpStatus.NOT_FOUND,
  DELIVERY_ZONE_VALIDATION_NOT_FOUND: HttpStatus.NOT_FOUND,
  DELIVERY_ZONE_VALIDATION_PENDING: HttpStatus.CONFLICT,
  VERSION_CONFLICT: HttpStatus.CONFLICT,
  IDEMPOTENCY_CONFLICT: HttpStatus.CONFLICT,
  ALREADY_RESOLVED: HttpStatus.CONFLICT,
  UNAUTHORIZED: HttpStatus.UNAUTHORIZED,
};

const MESSAGES: Record<DeliveryZoneErrorCode, string> = {
  DELIVERY_ZONE_NOT_FOUND: 'Delivery zone not found',
  DELIVERY_ZONE_VALIDATION_NOT_FOUND: 'Delivery zone validation not found',
  DELIVERY_ZONE_VALIDATION_PENDING:
    'A validation is pending for this postal code; resolve it instead',
  VERSION_CONFLICT: 'Delivery zone validation was modified by another reviewer',
  IDEMPOTENCY_CONFLICT: 'Request conflicts with a previous submission',
  ALREADY_RESOLVED: 'Delivery zone validation was already resolved',
  UNAUTHORIZED: 'Unauthorized',
};

@Catch(DeliveryZoneError, InvalidArgumentError)
export class DeliveryZoneHttpFilter implements ExceptionFilter {
  catch(
    exception: DeliveryZoneError | InvalidArgumentError,
    host: ArgumentsHost,
  ): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (exception instanceof DeliveryZoneError) {
      const code = exception.code as DeliveryZoneErrorCode;
      const statusCode = STATUS[code] ?? HttpStatus.INTERNAL_SERVER_ERROR;
      response.status(statusCode).json({
        statusCode,
        code,
        message: MESSAGES[code] ?? 'Internal server error',
      });
      return;
    }
    response.status(HttpStatus.BAD_REQUEST).json({
      statusCode: HttpStatus.BAD_REQUEST,
      code: 'INVALID_DELIVERY_ZONE',
      message: exception.message,
    });
  }
}
