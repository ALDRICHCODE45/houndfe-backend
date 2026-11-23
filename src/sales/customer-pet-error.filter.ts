import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import { Response } from 'express';
import { CustomerPetError } from '../customer-pets/domain/customer-pet-error';

/**
 * customer-pets / T3 — answers the sale-line pet errors (`PET_NOT_FOUND` 404,
 * `PET_CUSTOMER_MISMATCH` / `PET_ARCHIVED` 422) with the contract's code-only
 * envelope `{ statusCode, error: CODE, message: CODE }` (contract §8), the one
 * the pet routes answer. Bound to the POS sale controllers: the shared
 * `DomainExceptionFilter` only maps `DomainError`s and `CustomerPetError` is not
 * one.
 */
@Catch(CustomerPetError)
export class CustomerPetErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(CustomerPetErrorFilter.name);

  catch(exception: CustomerPetError, host: ArgumentsHost) {
    this.logger.warn(`[${exception.code}]`);
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(exception.status)
      .json({
        statusCode: exception.status,
        error: exception.code,
        message: exception.code,
        ...exception.details,
      });
  }
}
