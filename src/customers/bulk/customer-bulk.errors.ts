/**
 * customers-bulk-actions — error bodies of the bulk selection
 * (`docs/proposals/customers-bulk-actions-contract.md` §7, frontend L3.10).
 * Same envelope as the listing codes: `{ statusCode, code, message, field,
 * details? }`.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';

export enum CustomerBulkErrorCode {
  BULK_CUSTOMERS_NOT_FOUND = 'BULK_CUSTOMERS_NOT_FOUND',
  BULK_SELECTION_TOO_LARGE = 'BULK_SELECTION_TOO_LARGE',
  BULK_SELECTION_EMPTY = 'BULK_SELECTION_EMPTY',
}

/** Ids mode is strict: unknown, foreign-branch and deleted ids look the same. */
export function bulkCustomersNotFound(missingIds: string[]): NotFoundException {
  return new NotFoundException({
    statusCode: 404,
    code: CustomerBulkErrorCode.BULK_CUSTOMERS_NOT_FOUND,
    message: `${missingIds.length} customers not found`,
    field: 'customerIds',
    details: { missingIds },
  });
}

export function bulkSelectionTooLarge(
  count: number,
  max: number,
): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    code: CustomerBulkErrorCode.BULK_SELECTION_TOO_LARGE,
    message: `selection resolves to ${count} customers; max ${max}`,
    field: 'selection',
    details: { count, max },
  });
}

export function bulkSelectionEmpty(): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    code: CustomerBulkErrorCode.BULK_SELECTION_EMPTY,
    message: 'selection resolves to 0 customers',
    field: 'selection',
  });
}
