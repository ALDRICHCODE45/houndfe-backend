/**
 * cash-register-closing / S10 — query pagination and range parsing (S7).
 *
 * `from` is inclusive and `to` is EXCLUSIVE, so adjacent ranges never
 * double-count a row. Dates must carry an explicit UTC offset.
 */
import {
  CASH_APPLICATION_CODES,
  cashAppError,
} from '../application/cash-application.errors';

export function normalizePage(input: { page?: number; limit?: number }): {
  page: number;
  limit: number;
  skip: number;
} {
  const page = input.page ?? 1;
  const limit = input.limit ?? 20;
  if (!Number.isInteger(page) || page < 1) {
    throw cashAppError(
      CASH_APPLICATION_CODES.QUERY_INVALID_PAGE,
      'page must be a positive integer',
      { page },
    );
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw cashAppError(
      CASH_APPLICATION_CODES.QUERY_INVALID_PAGE,
      'limit must be between 1 and 100',
      { limit },
    );
  }
  return { page, limit, skip: (page - 1) * limit };
}

export function parseRange(
  from: string | undefined,
  to: string | undefined,
): { from: Date | null; to: Date | null } {
  const parsedFrom = from === undefined ? null : parseDate(from, 'from');
  const parsedTo = to === undefined ? null : parseDate(to, 'to');
  if (
    parsedFrom !== null &&
    parsedTo !== null &&
    parsedFrom.getTime() >= parsedTo.getTime()
  ) {
    throw cashAppError(
      CASH_APPLICATION_CODES.QUERY_RANGE_INVALID,
      'from must be strictly before to',
      { from, to },
    );
  }
  return { from: parsedFrom, to: parsedTo };
}

function parseDate(value: string, field: string): Date {
  const explicitTimezone =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
  if (typeof value !== 'string' || !explicitTimezone.test(value)) {
    throw cashAppError(
      CASH_APPLICATION_CODES.QUERY_DATE_INVALID,
      `${field} must be an ISO date with an explicit UTC offset`,
      { field, value },
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw cashAppError(
      CASH_APPLICATION_CODES.QUERY_DATE_INVALID,
      `${field} is not a valid date`,
      { field, value },
    );
  }
  return parsed;
}
