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
 *   can carry), so a JSON number/boolean/object never reaches the parsers;
 * - `__proto__`, `constructor` and `prototype` are rejected like any unknown
 *   param (advisory R3-filter-proto-key). `JSON.parse` keeps them as OWN keys,
 *   but the global pipe's class-transformer silently drops them from the
 *   nested `filter`, so the controller must also check the RAW body with
 *   `assertNoReservedBulkFilterKeys`.
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

/**
 * Object-prototype keys: never valid listing params, and dropped (or turned
 * into prototype writes) by naive object copies and class-transformer.
 */
export const BULK_FILTER_RESERVED_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

const exceptionFactory = createListingValidationExceptionFactory();

function whitelistError(key: string): ValidationError {
  return fieldError(key, {
    whitelistValidation: `property ${key} should not exist`,
  });
}

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

/**
 * Throws the same 400 an unknown filter param gets when the RAW (pre-pipe)
 * `selection.filter` carries an own reserved key. Non-objects are ignored
 * (the DTO rejects them).
 */
export function assertNoReservedBulkFilterKeys(raw: unknown): void {
  if (raw === null || typeof raw !== 'object') return;
  const errors = Object.keys(raw)
    .filter((key) => BULK_FILTER_RESERVED_KEYS.has(key))
    .map(whitelistError);
  if (errors.length > 0) throw exceptionFactory(errors);
}

/** How many object levels of the raw body are checked for reserved keys. */
export const MAX_RESERVED_KEY_DEPTH = 4;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The errors for every own reserved key of `raw` and of its nested plain
 * objects (arrays are not walked), shaped exactly like the global pipe's: a
 * reserved key is a `whitelistValidation` error on that property, nested
 * under its parents' `children`. `skip(path)` excludes a subtree checked elsewhere.
 */
function reservedKeyErrors(
  raw: Record<string, unknown>,
  path: readonly string[],
  skip: (path: readonly string[]) => boolean,
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const key of Object.keys(raw)) {
    if (BULK_FILTER_RESERVED_KEYS.has(key)) {
      // Exactly the pipe's unknown-property error (no `children` on a leaf).
      errors.push(
        Object.assign(new ValidationError(), {
          property: key,
          constraints: {
            whitelistValidation: `property ${key} should not exist`,
          },
        }),
      );
      continue;
    }
    const value = Object.getOwnPropertyDescriptor(raw, key)?.value as unknown;
    const childPath = [...path, key];
    if (
      !isPlainObject(value) ||
      childPath.length >= MAX_RESERVED_KEY_DEPTH ||
      skip(childPath)
    ) {
      continue;
    }
    const children = reservedKeyErrors(value, childPath, skip);
    if (children.length > 0) {
      errors.push(
        Object.assign(new ValidationError(), { property: key, children }),
      );
    }
  }
  return errors;
}

/**
 * Throws the 400 an unknown property gets when the RAW (pre-pipe) body
 * carries an own reserved key at the top level, inside `selection` or in any
 * nested plain object (up to `MAX_RESERVED_KEY_DEPTH` levels): the global
 * pipe would strip it silently. `selection.filter` keeps its own check
 * (`assertNoReservedBulkFilterKeys`, plain param names), run first.
 */
export function assertNoReservedBulkBodyKeys(body: unknown): void {
  if (!isPlainObject(body)) return;
  const selection = Object.getOwnPropertyDescriptor(body, 'selection')
    ?.value as unknown;
  if (isPlainObject(selection)) {
    assertNoReservedBulkFilterKeys(
      Object.getOwnPropertyDescriptor(selection, 'filter')?.value,
    );
  }
  const errors = reservedKeyErrors(
    body,
    [],
    (path) =>
      path.length === 2 && path[0] === 'selection' && path[1] === 'filter',
  );
  if (errors.length > 0) throw exceptionFactory(errors);
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
  // Null prototype: an own `__proto__` key can never reach a setter.
  const candidate = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(raw)) {
    if (
      BULK_FILTER_REJECTED_KEYS.has(key) ||
      BULK_FILTER_RESERVED_KEYS.has(key)
    ) {
      shapeErrors.push(whitelistError(key));
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

  const dto = plainToInstance(CustomersListingQueryDto, { ...candidate });
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
