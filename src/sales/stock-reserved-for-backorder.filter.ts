import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { StockReservedForBackorderError } from './stock-reserved-for-backorder.error';

/**
 * restock-backorder / T5b — answers `STOCK_RESERVED_FOR_BACKORDER` as a 409 with
 * the envelope of the shared `DomainExceptionFilter` (`statusCode`, `error`,
 * `message`, `timestamp`) plus `available` and `reserved` at the root, exactly
 * like the other domain 409s that carry details. Bound to the counter charge
 * route only (a route-level filter wins over the global one): the shared filter
 * maps by error code and this error is born in `src/sales`.
 */
@Catch(StockReservedForBackorderError)
export class StockReservedForBackorderFilter implements ExceptionFilter {
  private readonly logger = new Logger(StockReservedForBackorderFilter.name);

  catch(exception: StockReservedForBackorderError, host: ArgumentsHost) {
    this.logger.warn(`[${exception.code}] ${exception.message}`);
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(HttpStatus.CONFLICT)
      .json({
        statusCode: HttpStatus.CONFLICT,
        error: exception.code,
        message: exception.message,
        timestamp: exception.timestamp.toISOString(),
        available: exception.available,
        reserved: exception.reserved,
      });
  }
}
