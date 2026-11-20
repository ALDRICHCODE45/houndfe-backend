import type { StaffBackorderListFilter } from '../domain/backorder-staff-query';
import {
  searchTokens,
  staffListOrderBy,
  staffListWhere,
} from './backorder-staff-list.query';

const TENANT = 'tenant-1';
const ID = '3f2b8c1e-5d4a-4e6b-9c7d-1a2b3c4d5e6f';
const base: StaffBackorderListFilter = {
  page: 1,
  limit: 20,
  sortBy: 'scheduledAt',
  sortOrder: 'asc',
};

describe('staffListWhere', () => {
  it('always pins the tenant and adds nothing else without filters', () => {
    expect(staffListWhere(TENANT, base, { withStatus: true })).toEqual({
      tenantId: TENANT,
    });
  });

  it('applies the status filter to the page but not to the counts', () => {
    const filter = { ...base, statuses: ['WAITING', 'RESERVED'] as const };
    const input = { ...filter, statuses: [...filter.statuses] };
    expect(staffListWhere(TENANT, input, { withStatus: true })).toEqual({
      tenantId: TENANT,
      status: { in: ['WAITING', 'RESERVED'] },
    });
    expect(staffListWhere(TENANT, input, { withStatus: false })).toEqual({
      tenantId: TENANT,
    });
  });

  it('applies every other filter to both the page and the counts', () => {
    const filter: StaffBackorderListFilter = {
      ...base,
      statuses: ['EXPIRED'],
      productId: ID,
      variantId: ID,
      customerId: ID,
      from: new Date('2026-11-01T00:00:00Z'),
      to: new Date('2026-11-30T00:00:00Z'),
    };
    for (const withStatus of [true, false]) {
      expect(staffListWhere(TENANT, filter, { withStatus })).toMatchObject({
        tenantId: TENANT,
        productId: ID,
        variantId: ID,
        customerId: ID,
        scheduledAt: {
          gte: new Date('2026-11-01T00:00:00Z'),
          lte: new Date('2026-11-30T00:00:00Z'),
        },
      });
    }
  });

  it('supports an open-ended date range', () => {
    const from = new Date('2026-11-01T00:00:00Z');
    expect(
      staffListWhere(TENANT, { ...base, from }, { withStatus: true }),
    ).toEqual({ tenantId: TENANT, scheduledAt: { gte: from } });
    const to = new Date('2026-11-30T00:00:00Z');
    expect(
      staffListWhere(TENANT, { ...base, to }, { withStatus: true }),
    ).toEqual({
      tenantId: TENANT,
      scheduledAt: { lte: to },
    });
  });

  it('turns q into one AND group per token over customer, phone digits, product and variant', () => {
    const where = staffListWhere(
      TENANT,
      { ...base, q: 'Rosa 5512' },
      { withStatus: true },
    );
    const groups = where.AND as Array<{ OR: unknown[] }>;
    expect(groups).toHaveLength(2);
    const [word, digits] = groups.map((group) => JSON.stringify(group.OR));
    for (const text of [word, digits]) {
      expect(text).toContain('"product":{"name"');
      expect(text).toContain('"variant":{"name"');
      expect(text).toContain('"customer":{"firstName"');
      expect(text).toContain('"customer":{"lastName"');
    }
    expect(digits).toContain('"customer":{"phone":{"contains":"5512"');
    expect(word).not.toContain('"phone"');
  });

  it('matches a phone typed with punctuation through its digits', () => {
    const where = staffListWhere(
      TENANT,
      { ...base, q: '+52 (55) 1234' },
      { withStatus: true },
    );
    const text = JSON.stringify(where.AND);
    expect(text).toContain('"phone":{"contains":"52"');
    expect(text).toContain('"phone":{"contains":"1234"');
    expect(text).toContain('"phoneCountryCode":"52"');
  });
});

describe('searchTokens', () => {
  it('splits on whitespace and caps the token count', () => {
    expect(searchTokens('  a  b c ')).toEqual(['a', 'b', 'c']);
    expect(searchTokens('1 2 3 4 5 6 7 8')).toHaveLength(5);
  });
});

describe('staffListOrderBy', () => {
  it('sorts by scheduledAt with id as the stable tiebreaker', () => {
    expect(staffListOrderBy({ ...base, sortOrder: 'desc' })).toEqual([
      { scheduledAt: 'desc' },
      { id: 'asc' },
    ]);
  });

  it('sorts by status then queue order', () => {
    expect(staffListOrderBy({ ...base, sortBy: 'status' })).toEqual([
      { status: 'asc' },
      { scheduledAt: 'asc' },
      { id: 'asc' },
    ]);
  });

  it('puts a null reservedUntil last in both directions', () => {
    for (const sortOrder of ['asc', 'desc'] as const) {
      expect(
        staffListOrderBy({ ...base, sortBy: 'reservedUntil', sortOrder }),
      ).toEqual([
        { reservedUntil: { sort: sortOrder, nulls: 'last' } },
        { scheduledAt: 'asc' },
        { id: 'asc' },
      ]);
    }
  });
});
