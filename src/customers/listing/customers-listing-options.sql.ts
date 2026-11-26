/**
 * customers-listing — SQL of `GET /customers/listing/options`
 * (`docs/proposals/customers-list-contract.md` §5).
 *
 * Raw SQL is not tenant-scoped by the Prisma extension: `tenantId` is applied
 * explicitly. The column comes from a closed whitelist; `q` and `limit` are
 * bound parameters.
 */
import { Prisma } from '@prisma/client';
import { FISCAL_REGIMES } from '../domain/constants';
import { escapeLike } from '../customers.service';
import type { CustomersListingOptionsInput } from './customer-listing.types';

/** §5 field → `[table, column]`. Location fields read ANY address. */
const OPTION_SOURCES: Record<
  CustomersListingOptionsInput['field'],
  { table: 'customer_addresses' | 'customers'; column: string; owner: string }
> = {
  neighborhood: {
    table: 'customer_addresses',
    column: 'neighborhood',
    owner: 'customerId',
  },
  municipality: {
    table: 'customer_addresses',
    column: 'municipality',
    owner: 'customerId',
  },
  city: { table: 'customer_addresses', column: 'city', owner: 'customerId' },
  zipCode: {
    table: 'customer_addresses',
    column: 'zipCode',
    owner: 'customerId',
  },
  fiscalRegime: { table: 'customers', column: 'fiscalRegime', owner: 'id' },
};

/**
 * Distinct values with the number of customers that have them:
 *
 * - values are trimmed and grouped by `lower(trim(value))`; blank ones are
 *   skipped;
 * - `value` is the group's most frequent spelling (by customers; ties → the
 *   lowest spelling), so selecting it matches the whole group through the
 *   trimmed case-insensitive filter of §4.4;
 * - `customersCount` counts distinct customers (a customer with two addresses
 *   in one colonia counts once);
 * - `q` is a case-insensitive `contains` on the trimmed value;
 * - `fiscalRegime` returns only the SAT codes in use (`FISCAL_REGIMES`);
 * - sorted by `customersCount` desc, then `value`, limited.
 */
export function buildListingOptionsSql(
  tenantId: string,
  input: CustomersListingOptionsInput,
): Prisma.Sql {
  const source = OPTION_SOURCES[input.field];
  const table = Prisma.raw(`"${source.table}"`);
  const value = Prisma.raw(`btrim(t."${source.column}")`);
  const owner = Prisma.raw(`t."${source.owner}"`);
  const conditions: Prisma.Sql[] = [
    Prisma.sql`t."tenantId" = ${tenantId}`,
    Prisma.sql`${value} <> ''`,
  ];
  if (input.q) {
    conditions.push(Prisma.sql`${value} ILIKE ${`%${escapeLike(input.q)}%`}`);
  }
  if (input.field === 'fiscalRegime') {
    conditions.push(
      Prisma.sql`${value} = ANY (${[...FISCAL_REGIMES]}::text[])`,
    );
  }
  return Prisma.sql`
    WITH v AS (
      SELECT ${owner} AS "customerId", ${value} AS "value", lower(${value}) AS "key"
      FROM ${table} t
      WHERE ${Prisma.join(conditions, ' AND ')}
    ), spelling AS (
      SELECT DISTINCT ON ("key") "key", "value"
      FROM (
        SELECT "key", "value", COUNT(DISTINCT "customerId") AS n
        FROM v GROUP BY "key", "value"
      ) s
      ORDER BY "key", n DESC, "value" ASC
    ), grouped AS (
      SELECT "key", COUNT(DISTINCT "customerId")::int AS "customersCount"
      FROM v GROUP BY "key"
    )
    SELECT spelling."value", grouped."customersCount"
    FROM grouped JOIN spelling ON spelling."key" = grouped."key"
    ORDER BY grouped."customersCount" DESC, spelling."value" ASC
    LIMIT ${input.limit}`;
}
