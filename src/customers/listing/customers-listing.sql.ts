/**
 * customers-listing / T1 — SQL of `GET /customers/listing`
 * (`docs/proposals/customers-list-contract.md` §12.2).
 *
 * Every table carries an explicit `"tenantId" = ${tenantId}`: raw queries are
 * not tenant-scoped by the Prisma extension. Identifiers and directions come
 * from closed whitelists below; user input only ever reaches the query as a
 * bound parameter.
 *
 * Shape:
 *   c   — customers of the tenant matching the customer-level filters/search;
 *   pg  — the page: either metrics LATERAL over every `c` row, metric filters,
 *         ORDER BY, LIMIT (metric sort or metric filter), or `c` paged first
 *         with the metrics LATERAL run for the page rows only;
 *   the final SELECT adds the page-only joins (primary address, pets, price
 *   list, matched pet).
 * The totals are a second statement over the same `c` (+ metric filters).
 */
import { Prisma } from '@prisma/client';
import { petNameKey } from '../../customer-pets/domain/customer-pet-rules';
import { escapeLike } from '../customers.service';
import { customerSalesMetricsSql } from './customer-sales-metrics.sql';
import type {
  CustomerListingFilters,
  CustomersListingReadInput,
} from './customer-listing.types';
import { METRIC_SORT_KEYS } from './customers-listing.permissions';

/** Contract §4.6 / `GET /customers`: trimmed, cut to 100 characters. */
export function normalizeSearch(search: unknown): string {
  return typeof search === 'string' ? search.trim().slice(0, 100) : '';
}

interface SearchParts {
  /** Every word (max 6) in one of the five own fields. */
  own: Prisma.Sql;
  /** `LIKE` pattern over ACTIVE pets' `nameKey`, or null (no usable key). */
  petPattern: string | null;
}

/**
 * Reproduces `CustomersService.ownFieldsWhere` + the pet branch of
 * `findAll`: Prisma `contains` + `mode: 'insensitive'` is `ILIKE '%…%'`,
 * plain `contains` is `LIKE '%…%'`; `escapeLike` makes `%`, `_`, `\` literal.
 */
function searchParts(term: string): SearchParts {
  const words = term.split(/\s+/).slice(0, 6);
  const own = Prisma.join(
    words.map((word) => {
      const pattern = `%${escapeLike(word)}%`;
      return Prisma.sql`(c."firstName" ILIKE ${pattern} OR c."lastName" ILIKE ${pattern} OR c."email" ILIKE ${pattern} OR c."phone" ILIKE ${pattern} OR c."businessName" ILIKE ${pattern})`;
    }),
    ' AND ',
  );
  const key = petNameKey(term);
  return { own, petPattern: key ? `%${escapeLike(key)}%` : null };
}

function activePetMatch(
  tenantId: string,
  customerId: Prisma.Sql,
  pattern: string,
): Prisma.Sql {
  return Prisma.sql`p."tenantId" = ${tenantId} AND p."customerId" = ${customerId} AND p."status" = 'ACTIVE' AND p."nameKey" LIKE ${pattern}`;
}

/**
 * Customer-level WHERE conditions (on alias `c`). T3 appends the §4.3–§4.5
 * filters and `createdFrom/To` here.
 */
export function customerFilterConditions(
  tenantId: string,
  filters: CustomerListingFilters,
): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = [Prisma.sql`c."tenantId" = ${tenantId}`];
  const term = normalizeSearch(filters.search);
  if (term) {
    const { own, petPattern } = searchParts(term);
    conditions.push(
      petPattern
        ? Prisma.sql`((${own}) OR EXISTS (SELECT 1 FROM "customer_pets" p WHERE ${activePetMatch(tenantId, Prisma.sql`c."id"`, petPattern)}))`
        : Prisma.sql`(${own})`,
    );
  }
  return conditions;
}

/**
 * Metric WHERE conditions over the metric columns of `alias` (§4.1, §4.2).
 * T1: none yet — T3 implements them here.
 */
export function metricFilterConditions(
  filters: CustomerListingFilters,
  alias: string,
): Prisma.Sql[] {
  void filters;
  void alias;
  return [];
}

/** True when a metric filter forces computing metrics before paging (T3). */
export function hasMetricFilters(filters: CustomerListingFilters): boolean {
  return metricFilterConditions(filters, 'r').length > 0;
}

/** `true` when the customer matched through a pet only (→ `matchedPetName`). */
function viaPetOnlyColumn(filters: CustomerListingFilters): Prisma.Sql {
  const term = normalizeSearch(filters.search);
  if (!term) return Prisma.sql`false`;
  const { own, petPattern } = searchParts(term);
  if (!petPattern) return Prisma.sql`false`;
  return Prisma.sql`NOT COALESCE((${own}), false)`;
}

const CUSTOMER_COLUMNS = [
  'id',
  'firstName',
  'lastName',
  'businessName',
  'phoneCountryCode',
  'phone',
  'email',
  'globalPriceListId',
  'rfc',
  'fiscalRegime',
  'preferredPaymentMethod',
  'isTrusted',
  'createdAt',
] as const;

const METRIC_COLUMNS = [
  'salesCount',
  'totalSoldCents',
  'openDebtCents',
  'overdueCount',
  'overdueDebtCents',
  'oldestOverdueDueDate',
  'lastPurchaseAt',
  'averageTicketCents',
] as const;

/** §3.3 sort keys → the columns of the paged relation, in order. */
const SORT_COLUMNS: Record<CustomersListingReadInput['sortBy'], string[]> = {
  name: ['lower(%."firstName")', 'lower(%."lastName")'],
  openDebt: ['%."openDebtCents"'],
  oldestOverdue: ['%."oldestOverdueDueDate"'],
  lastPurchaseAt: ['%."lastPurchaseAt"'],
  totalSold: ['%."totalSoldCents"'],
  salesCount: ['%."salesCount"'],
  averageTicket: ['%."averageTicketCents"'],
  createdAt: ['%."createdAt"'],
};

/** Nulls always last (§3.3); `id` is the final tie-breaker (stable pages). */
function orderBy(input: CustomersListingReadInput, alias: string): Prisma.Sql {
  const direction = input.sortOrder === 'asc' ? 'ASC' : 'DESC';
  const items = SORT_COLUMNS[input.sortBy].map(
    (column) => `${column.replace('%', alias)} ${direction} NULLS LAST`,
  );
  items.push(`${alias}."id" ${direction}`);
  return Prisma.raw(`ORDER BY ${items.join(', ')}`);
}

function candidatesCte(
  tenantId: string,
  filters: CustomerListingFilters,
): Prisma.Sql {
  const columns = Prisma.raw(
    CUSTOMER_COLUMNS.map((column) => `c."${column}"`).join(', '),
  );
  return Prisma.sql`c AS (
    SELECT ${columns}, ${viaPetOnlyColumn(filters)} AS "viaPetOnly"
    FROM "customers" c
    WHERE ${Prisma.join(customerFilterConditions(tenantId, filters), ' AND ')}
  )`;
}

function whereClause(conditions: Prisma.Sql[]): Prisma.Sql {
  return conditions.length > 0
    ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
    : Prisma.empty;
}

/** Page statement: one row per customer of the page, already sorted. */
export function buildListingPageSql(
  tenantId: string,
  input: CustomersListingReadInput,
): Prisma.Sql {
  const offset = (input.page - 1) * input.limit;
  const metrics = input.metrics;
  // A metric sort or filter needs every candidate's metrics before LIMIT.
  const metricsFirst =
    metrics !== null &&
    (METRIC_SORT_KEYS.has(input.sortBy) || hasMetricFilters(input.filters));

  const page = metricsFirst
    ? Prisma.sql`pg AS (
        SELECT r.* FROM (
          SELECT c.*, m.* FROM c
          LEFT JOIN LATERAL (${customerSalesMetricsSql({ tenantId, customerId: Prisma.sql`c."id"`, overdueBefore: metrics.overdueBefore })}) m ON true
        ) r
        ${whereClause(metricFilterConditions(input.filters, 'r'))}
        ${orderBy(input, 'r')}
        LIMIT ${input.limit} OFFSET ${offset}
      )`
    : Prisma.sql`pg AS (
        SELECT c.* FROM c
        ${orderBy(input, 'c')}
        LIMIT ${input.limit} OFFSET ${offset}
      )`;

  const metricsAlias = metricsFirst ? 'pg' : 'm';
  const metricsSelect = metrics
    ? Prisma.raw(
        METRIC_COLUMNS.map(
          (column) => `, ${metricsAlias}."${column}" AS "${column}"`,
        ).join(''),
      )
    : Prisma.empty;
  const metricsJoin =
    metrics && !metricsFirst
      ? Prisma.sql`LEFT JOIN LATERAL (${customerSalesMetricsSql({ tenantId, customerId: Prisma.sql`pg."id"`, overdueBefore: metrics.overdueBefore })}) m ON true`
      : Prisma.empty;

  const term = normalizeSearch(input.filters.search);
  const petPattern = term ? searchParts(term).petPattern : null;
  const matchedPetName = petPattern
    ? Prisma.sql`CASE WHEN pg."viaPetOnly" THEN (
        SELECT p."name" FROM "customer_pets" p
        WHERE ${activePetMatch(tenantId, Prisma.sql`pg."id"`, petPattern)}
        ORDER BY p."nameKey" ASC, p."createdAt" ASC, p."id" ASC
        LIMIT 1
      ) END`
    : Prisma.sql`NULL::text`;

  const customerSelect = Prisma.raw(
    CUSTOMER_COLUMNS.map((column) => `pg."${column}"`).join(', '),
  );

  return Prisma.sql`
    WITH ${candidatesCte(tenantId, input.filters)},
    ${page}
    SELECT ${customerSelect},
      gpl."name" AS "globalPriceListName",
      pa."id" AS "addressId",
      pa."neighborhood" AS "addressNeighborhood",
      pa."municipality" AS "addressMunicipality",
      pa."city" AS "addressCity",
      pa."state" AS "addressState",
      pa."zipCode" AS "addressZipCode",
      pt."activePetsCount",
      pt."petSpecies",
      ${matchedPetName} AS "matchedPetName"
      ${metricsSelect}
    FROM pg
    ${metricsJoin}
    LEFT JOIN LATERAL (
      SELECT a."id", a."neighborhood", a."municipality", a."city", a."state", a."zipCode"
      FROM "customer_addresses" a
      WHERE a."tenantId" = ${tenantId} AND a."customerId" = pg."id"
      ORDER BY a."createdAt" ASC, a."id" ASC
      LIMIT 1
    ) pa ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS "activePetsCount",
             COALESCE(array_agg(DISTINCT p."species" ORDER BY p."species"), '{}')::text[] AS "petSpecies"
      FROM "customer_pets" p
      WHERE p."tenantId" = ${tenantId} AND p."customerId" = pg."id" AND p."status" = 'ACTIVE'
    ) pt ON true
    LEFT JOIN "global_price_lists" gpl ON gpl."id" = pg."globalPriceListId"
    ${orderBy(input, 'pg')}`;
}

/**
 * Totals statement (§3.2): `count` of every matching customer and, with
 * `read:Sale`, the debt sums over the same set. Never windowed over the page,
 * so a page past the end still reports the real totals.
 */
export function buildListingSummarySql(
  tenantId: string,
  input: CustomersListingReadInput,
): Prisma.Sql {
  const cte = candidatesCte(tenantId, input.filters);
  if (!input.metrics) {
    return Prisma.sql`WITH ${cte} SELECT COUNT(*)::int AS "count" FROM c`;
  }
  return Prisma.sql`
    WITH ${cte}
    SELECT COUNT(*)::int AS "count",
           COALESCE(SUM(r."openDebtCents"), 0)::bigint AS "openDebtCents",
           COALESCE(SUM(r."overdueDebtCents"), 0)::bigint AS "overdueDebtCents"
    FROM (
      SELECT c."id", m.* FROM c
      LEFT JOIN LATERAL (${customerSalesMetricsSql({ tenantId, customerId: Prisma.sql`c."id"`, overdueBefore: input.metrics.overdueBefore })}) m ON true
    ) r
    ${whereClause(metricFilterConditions(input.filters, 'r'))}`;
}
