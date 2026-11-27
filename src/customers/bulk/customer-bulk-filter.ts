/**
 * customers-bulk-actions / T1 (S1) — validation of `selection.filter`
 * (`docs/proposals/customers-bulk-actions-contract.md` §2.1, §2.3, §11
 * «nested validation error mapping»).
 *
 * The filter holds the `GET /customers/listing` params as the frontend puts
 * them in the URL. It is validated with `CustomersListingQueryDto` and the
 * SAME options and exception factory as the global pipe, so every value means
 * what it means in the table and every error keeps the listing envelope, code
 * and plain param name (`field: "openDebtMin"`, never `filter.openDebtMin`).
 *
 * On top of the listing rules:
 * - `page`, `limit`, `sortBy`, `sortOrder` are rejected (no pagination; the
 *   order is a top-level field of the action);
 * - every value must be a string or an array of strings (what a query string
 *   can carry), so a JSON number/boolean/object never reaches the parsers.
 */
import { plainToInstance } from 'class-transformer';
import { ValidationError, validateSync } from 'class-validator';
import { createListingValidationExceptionFactory } from '../../shared/listing/listing-validation-exception.factory';
import {
  CUSTOMER_LISTING_FILTER_KEYS,
  type CustomerListingFilters,
} from '../listing/customer-listing.types';
import { CustomersListingQueryDto } from '../listing/customers-listing-query.dto';

/** Listing params that are not filters (§2.1). */
export const BULK_FILTER_REJECTED_KEYS: ReadonlySet<string> = new Set([
  'page',
  'limit',
  'sortBy',
  'sortOrder',
]);

const exceptionFactory = createListingValidationExceptionFactory();

function fieldError(
  property: string,
  constraints: Record<string, string>,
): ValidationError {
  return Object.assign(new ValidationError(), {
    property,
    children: [],
    constraints,
  });
}

/** What a query-string value can be: a string or a repeated param. */
function isUrlValue(value: unknown): boolean {
  return (
    typeof value === 'string' ||
    (Array.isArray(value) && value.every((item) => typeof item === 'string'))
  );
}

/**
 * Validates `selection.filter` and returns the defined listing filters (empty
 * CSV lists dropped, as the listing does). Throws the listing 400 bodies.
 * The §10.1 metric-param permission rule is applied by the resolver, after
 * this validation (listing order).
 */
export function parseCustomerBulkFilter(
  raw: Readonly<Record<string, unknown>>,
): CustomerListingFilters {
  const shapeErrors: ValidationError[] = [];
  const candidate: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (BULK_FILTER_REJECTED_KEYS.has(key)) {
      shapeErrors.push(
        fieldError(key, {
          whitelistValidation: `property ${key} should not exist`,
        }),
      );
    } else if (!isUrlValue(value)) {
      shapeErrors.push(
        fieldError(key, {
          isString: `${key} must be a string or an array of strings`,
        }),
      );
    } else {
      candidate[key] = value;
    }
  }

  const dto = plainToInstance(CustomersListingQueryDto, candidate);
  const errors = [
    ...shapeErrors,
    ...validateSync(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
      validationError: { target: false, value: false },
    }),
  ];
  if (errors.length > 0) throw exceptionFactory(errors);

  const source = dto as unknown as Record<string, unknown>;
  const filters: Record<string, unknown> = {};
  for (const key of CUSTOMER_LISTING_FILTER_KEYS) {
    const value = source[key];
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    filters[key] = value;
  }
  return filters as CustomerListingFilters;
}
