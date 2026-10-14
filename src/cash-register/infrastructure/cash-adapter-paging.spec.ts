/**
 * cash-register-closing / S10 — characterization of query pagination and
 * range parsing (`cash-adapter-paging`).
 *
 * `from` inclusive / `to` exclusive is the contract the query handlers build
 * on; these tests pin the accepted shape and the fail-closed rejections.
 */
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';
import { CASH_APPLICATION_CODES } from '../application/cash-application.errors';
import { normalizePage, parseRange } from './cash-adapter-paging';

function expectCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(BusinessRuleViolationError);
  expect((caught as BusinessRuleViolationError).code).toBe(code);
}

describe('cash-adapter-paging — normalizePage', () => {
  it('Given no paging input, when normalizing, then it defaults to page 1 / limit 20', () => {
    expect(normalizePage({})).toEqual({ page: 1, limit: 20, skip: 0 });
  });

  it('Given an explicit page, when normalizing, then skip is derived from page and limit', () => {
    expect(normalizePage({ page: 3, limit: 25 })).toEqual({
      page: 3,
      limit: 25,
      skip: 50,
    });
  });

  it('Given the limit boundaries, when normalizing, then 1 and 100 are accepted', () => {
    expect(normalizePage({ limit: 1 }).limit).toBe(1);
    expect(normalizePage({ limit: 100 }).limit).toBe(100);
  });

  it('Given an invalid page, when normalizing, then it is rejected', () => {
    expectCode(
      () => normalizePage({ page: 0 }),
      CASH_APPLICATION_CODES.QUERY_INVALID_PAGE,
    );
    expectCode(
      () => normalizePage({ page: 1.5 }),
      CASH_APPLICATION_CODES.QUERY_INVALID_PAGE,
    );
  });

  it('Given an invalid limit, when normalizing, then it is rejected', () => {
    expectCode(
      () => normalizePage({ limit: 0 }),
      CASH_APPLICATION_CODES.QUERY_INVALID_PAGE,
    );
    expectCode(
      () => normalizePage({ limit: 101 }),
      CASH_APPLICATION_CODES.QUERY_INVALID_PAGE,
    );
    expectCode(
      () => normalizePage({ limit: 20.5 }),
      CASH_APPLICATION_CODES.QUERY_INVALID_PAGE,
    );
  });
});

describe('cash-adapter-paging — parseRange', () => {
  it('Given no bounds, when parsing, then both sides are null', () => {
    expect(parseRange(undefined, undefined)).toEqual({
      from: null,
      to: null,
    });
  });

  it('Given offset-qualified bounds, when parsing, then both become Dates', () => {
    const range = parseRange(
      '2025-01-01T00:00:00Z',
      '2025-01-02T00:00:00+02:00',
    );
    expect(range.from?.toISOString()).toBe('2025-01-01T00:00:00.000Z');
    expect(range.to?.toISOString()).toBe('2025-01-01T22:00:00.000Z');
  });

  it('Given an inverted or equal range, when parsing, then it is rejected', () => {
    expectCode(
      () => parseRange('2025-01-02T00:00:00Z', '2025-01-01T00:00:00Z'),
      CASH_APPLICATION_CODES.QUERY_RANGE_INVALID,
    );
    expectCode(
      () => parseRange('2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'),
      CASH_APPLICATION_CODES.QUERY_RANGE_INVALID,
    );
  });

  it('Given a date without an explicit UTC offset, when parsing, then it is rejected', () => {
    expectCode(
      () => parseRange('2025-01-01T00:00:00', undefined),
      CASH_APPLICATION_CODES.QUERY_DATE_INVALID,
    );
    expectCode(
      () => parseRange(undefined, '2025-01-01'),
      CASH_APPLICATION_CODES.QUERY_DATE_INVALID,
    );
  });

  it('Given a well-shaped but impossible date, when parsing, then it is rejected', () => {
    expectCode(
      () => parseRange('2025-13-40T00:00:00Z', undefined),
      CASH_APPLICATION_CODES.QUERY_DATE_INVALID,
    );
  });
});
