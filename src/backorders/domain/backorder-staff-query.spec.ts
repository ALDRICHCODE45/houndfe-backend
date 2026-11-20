import { BackorderError } from './backorder-error';
import {
  emptyStatusCounts,
  parseStaffCancelBody,
  parseStaffListQuery,
  STAFF_LIST_DEFAULT_LIMIT,
  STAFF_LIST_MAX_LIMIT,
  toStatusCounts,
} from './backorder-staff-query';

const ID = '3f2b8c1e-5d4a-4e6b-9c7d-1a2b3c4d5e6f';

const invalid = (value: unknown, parse: (v: unknown) => unknown) => {
  try {
    parse(value);
  } catch (error) {
    expect(error).toBeInstanceOf(BackorderError);
    expect((error as BackorderError).code).toBe('INVALID_BACKORDER_REQUEST');
    expect((error as BackorderError).status).toBe(400);
    return;
  }
  throw new Error(
    `expected INVALID_BACKORDER_REQUEST for ${JSON.stringify(value)}`,
  );
};

describe('parseStaffListQuery (contract v1 §9.1)', () => {
  it('defaults: page 1, limit 20, scheduledAt asc, no filters', () => {
    expect(parseStaffListQuery({})).toEqual({
      page: 1,
      limit: STAFF_LIST_DEFAULT_LIMIT,
      sortBy: 'scheduledAt',
      sortOrder: 'asc',
    });
  });

  it('parses every filter', () => {
    const parsed = parseStaffListQuery({
      page: '3',
      limit: '50',
      status: 'WAITING, RESERVED,WAITING',
      productId: ID,
      variantId: ID,
      customerId: ID,
      q: '  Rosa  croquetas ',
      from: '2026-11-01T00:00:00-06:00',
      to: '2026-11-30T23:59:59.999Z',
      sortBy: 'reservedUntil',
      sortOrder: 'desc',
    });
    expect(parsed).toEqual({
      page: 3,
      limit: 50,
      statuses: ['WAITING', 'RESERVED'],
      productId: ID,
      variantId: ID,
      customerId: ID,
      q: 'Rosa  croquetas',
      from: new Date('2026-11-01T06:00:00.000Z'),
      to: new Date('2026-11-30T23:59:59.999Z'),
      sortBy: 'reservedUntil',
      sortOrder: 'desc',
    });
  });

  it('accepts each sortBy and treats empty values as absent', () => {
    for (const sortBy of ['scheduledAt', 'status', 'reservedUntil']) {
      expect(parseStaffListQuery({ sortBy }).sortBy).toBe(sortBy);
    }
    expect(
      parseStaffListQuery({ status: '', q: '   ', productId: '', from: '' }),
    ).toEqual(parseStaffListQuery({}));
  });

  it('accepts the maximum limit and rejects one above it', () => {
    expect(
      parseStaffListQuery({ limit: String(STAFF_LIST_MAX_LIMIT) }).limit,
    ).toBe(STAFF_LIST_MAX_LIMIT);
    invalid({ limit: String(STAFF_LIST_MAX_LIMIT + 1) }, parseStaffListQuery);
  });

  it.each([
    [{ page: '0' }],
    [{ page: '-1' }],
    [{ page: '1.5' }],
    [{ page: 'abc' }],
    [{ limit: '0' }],
    [{ status: 'WAITING,BOGUS' }],
    [{ status: 'waiting' }],
    [{ productId: 'not-a-uuid' }],
    [{ variantId: 'x' }],
    [{ customerId: '123' }],
    [{ q: 'x'.repeat(101) }],
    [{ from: '2026-11-01' }],
    [{ from: '2026-11-01T00:00:00' }],
    [{ to: 'yesterday' }],
    [{ from: '2026-12-01T00:00:00Z', to: '2026-11-01T00:00:00Z' }],
    [{ sortBy: 'folio' }],
    [{ sortBy: 'updatedAt' }],
    [{ sortOrder: 'ASC' }],
    [{ sortOrder: 'up' }],
    [{ tenantId: ID }],
    [{ page: ['1', '2'] }],
    [{ q: { $ne: 'x' } }],
  ])('rejects %j with INVALID_BACKORDER_REQUEST', (query) => {
    invalid(query, parseStaffListQuery);
  });

  it('rejects a non-object query', () => {
    invalid(null, parseStaffListQuery);
    invalid('page=1', parseStaffListQuery);
  });
});

describe('parseStaffCancelBody (contract v1 §9.3)', () => {
  it('requires an integer version >= 1; reason is optional', () => {
    expect(parseStaffCancelBody({ version: 3 })).toEqual({
      reason: null,
      version: 3,
    });
    expect(
      parseStaffCancelBody({ version: 1, reason: '  Cliente llamó  ' }),
    ).toEqual({
      reason: 'Cliente llamó',
      version: 1,
    });
    expect(
      parseStaffCancelBody({ version: 2, reason: null }).reason,
    ).toBeNull();
    expect(
      parseStaffCancelBody({ version: 2, reason: '   ' }).reason,
    ).toBeNull();
  });

  it('accepts a reason of exactly 280 characters, rejects 281', () => {
    expect(
      parseStaffCancelBody({ version: 1, reason: 'a'.repeat(280) }).reason,
    ).toHaveLength(280);
    invalid({ version: 1, reason: 'a'.repeat(281) }, parseStaffCancelBody);
  });

  it.each([
    [undefined],
    [null],
    [{}],
    [{ reason: 'x' }],
    [{ version: 0 }],
    [{ version: -1 }],
    [{ version: 1.5 }],
    [{ version: '1' }],
    [{ version: 1, reason: 5 }],
    [{ version: 1, extra: true }],
    [[]],
  ])('rejects %j', (body) => {
    invalid(body, parseStaffCancelBody);
  });
});

describe('status counts', () => {
  it('starts every status at zero', () => {
    expect(emptyStatusCounts()).toEqual({
      WAITING: 0,
      RESERVED: 0,
      CONFIRMED: 0,
      EXPIRED: 0,
      CANCELLED: 0,
    });
  });

  it('fills the groups and keeps the missing statuses at zero', () => {
    expect(
      toStatusCounts([
        { status: 'WAITING', count: 4 },
        { status: 'CANCELLED', count: 1 },
      ]),
    ).toEqual({
      WAITING: 4,
      RESERVED: 0,
      CONFIRMED: 0,
      EXPIRED: 0,
      CANCELLED: 1,
    });
  });
});
