/**
 * customers-listing — SQL of `GET /customers/listing`
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
  CustomerListingIdConditions,
  CustomersListingReadInput,
} from './customer-listing.types';
import {
  METRIC_FILTER_PARAMS,
  METRIC_SORT_KEYS,
} from './customers-listing.permissions';

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

/** A `timestamp(3)` column holds the UTC wall clock: bind instants as such. */
function utcWall(instant: Date): Prisma.Sql {
  return Prisma.sql`(${instant.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

/** Non-empty CSV list, or `undefined` (an empty list is no filter). */
function list(values: string[] | undefined): string[] | undefined {
  return values && values.length > 0 ? values : undefined;
}

/** «set» for a free-text column: not null and not blank. */
function isSet(column: string): Prisma.Sql {
  return Prisma.raw(`(${column} IS NOT NULL AND btrim(${column}) <> '')`);
}

function presence(column: string, wanted: boolean): Prisma.Sql {
  return wanted ? isSet(column) : Prisma.sql`NOT ${isSet(column)}`;
}

/** Trimmed, case-insensitive exact match against any of `values` (§4.4). */
function textIn(column: string, values: string[]): Prisma.Sql {
  return Prisma.sql`lower(btrim(${Prisma.raw(column)})) = ANY (SELECT lower(btrim(v)) FROM unnest(${values}::text[]) AS v)`;
}

/** The §4.4 address columns, by filter key. */
const LOCATION_COLUMNS = {
  neighborhood: 'neighborhood',
  municipality: 'municipality',
  city: 'city',
  zipCode: 'zipCode',
} as const;

/** True when a §4.4 location filter is active (→ `matchedAddressId`). */
export function hasLocationFilters(filters: CustomerListingFilters): boolean {
  return (
    Object.keys(LOCATION_COLUMNS).some(
      (key) =>
        list(filters[key as keyof typeof LOCATION_COLUMNS]) !== undefined,
    ) ||
    list(filters.deliveryZoneType) !== undefined ||
    filters.deliveryZoneNone === true
  );
}

/**
 * §4.4 conditions over ONE address (alias `a`). Every active location filter
 * must hold on the same address, so `matchedAddressId` always names an
 * address that explains the row. `deliveryZoneType` and `deliveryZoneNone`
 * are one zone filter: the address's zone category (an active zone's type, or
 * «sin zona») is one of the selected ones.
 */
function addressConditions(
  tenantId: string,
  filters: CustomerListingFilters,
): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = [];
  for (const [key, column] of Object.entries(LOCATION_COLUMNS)) {
    const values = list(filters[key as keyof typeof LOCATION_COLUMNS]);
    if (values) conditions.push(textIn(`a."${column}"`, values));
  }
  // ZIP codes are free text: trimmed equality with the 5-char zone code (§13).
  const activeZone = Prisma.sql`SELECT 1 FROM "delivery_zones" z
    WHERE z."tenantId" = ${tenantId} AND z."isActive" = true
      AND z."zipCode" = btrim(a."zipCode")`;
  const zone: Prisma.Sql[] = [];
  const types = list(filters.deliveryZoneType);
  if (types) {
    zone.push(
      Prisma.sql`EXISTS (${activeZone} AND z."type"::text = ANY (${types}::text[]))`,
    );
  }
  if (filters.deliveryZoneNone === true) {
    zone.push(
      Prisma.sql`(btrim(a."zipCode") <> '' AND NOT EXISTS (${activeZone}))`,
    );
  }
  if (zone.length > 0)
    conditions.push(Prisma.sql`(${Prisma.join(zone, ' OR ')})`);
  return conditions;
}

/** The customer's addresses matching every active §4.4 filter (alias `a`). */
function matchingAddressesWhere(
  tenantId: string,
  customerId: Prisma.Sql,
  filters: CustomerListingFilters,
): Prisma.Sql {
  return Prisma.join(
    [
      Prisma.sql`a."tenantId" = ${tenantId} AND a."customerId" = ${customerId}`,
      ...addressConditions(tenantId, filters),
    ],
    ' AND ',
  );
}

/** §4.3 — ACTIVE pets of the customer (alias `p`). */
function activePets(tenantId: string): Prisma.Sql {
  return Prisma.sql`p."tenantId" = ${tenantId} AND p."customerId" = c."id" AND p."status" = 'ACTIVE'`;
}

function petConditions(
  tenantId: string,
  filters: CustomerListingFilters,
): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = [];
  const species = list(filters.petSpecies);
  const sizes = list(filters.petSize);
  if (species || sizes) {
    // The SAME pet must match both (frontend Q7); a pet without a size never
    // matches `petSize` (`NULL = ANY(...)` is not true).
    const parts = [activePets(tenantId)];
    if (species) {
      parts.push(Prisma.sql`p."species"::text = ANY (${species}::text[])`);
    }
    if (sizes) parts.push(Prisma.sql`p."size"::text = ANY (${sizes}::text[])`);
    conditions.push(
      Prisma.sql`EXISTS (SELECT 1 FROM "customer_pets" p WHERE ${Prisma.join(parts, ' AND ')})`,
    );
  }
  if (
    filters.activePetsMin !== undefined ||
    filters.activePetsMax !== undefined
  ) {
    const count = Prisma.sql`(SELECT COUNT(*) FROM "customer_pets" p WHERE ${activePets(tenantId)})`;
    if (filters.activePetsMin !== undefined) {
      conditions.push(Prisma.sql`${count} >= ${filters.activePetsMin}`);
    }
    if (filters.activePetsMax !== undefined) {
      conditions.push(Prisma.sql`${count} <= ${filters.activePetsMax}`);
    }
  }
  if (filters.hasPets !== undefined) {
    const exists = Prisma.sql`EXISTS (SELECT 1 FROM "customer_pets" p WHERE ${activePets(tenantId)})`;
    conditions.push(filters.hasPets ? exists : Prisma.sql`NOT ${exists}`);
  }
  return conditions;
}

function commercialConditions(
  tenantId: string,
  filters: CustomerListingFilters,
): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = [];
  const priceLists = list(filters.priceListId);
  const includeNull = filters.priceListIncludeNull === true;
  if (priceLists || includeNull) {
    const parts: Prisma.Sql[] = [];
    if (priceLists) {
      parts.push(
        Prisma.sql`c."globalPriceListId" = ANY (${priceLists}::text[])`,
      );
    }
    if (includeNull) parts.push(Prisma.sql`c."globalPriceListId" IS NULL`);
    conditions.push(Prisma.sql`(${Prisma.join(parts, ' OR ')})`);
  }
  if (filters.isTrusted !== undefined) {
    conditions.push(Prisma.sql`c."isTrusted" = ${filters.isTrusted}`);
  }
  if (filters.hasRfc !== undefined) {
    conditions.push(presence('c."rfc"', filters.hasRfc));
  }
  const regimes = list(filters.fiscalRegime);
  if (regimes) {
    conditions.push(Prisma.sql`c."fiscalRegime" = ANY (${regimes}::text[])`);
  }
  if (filters.hasEmail !== undefined) {
    conditions.push(presence('c."email"', filters.hasEmail));
  }
  if (filters.hasPhone !== undefined) {
    conditions.push(presence('c."phone"', filters.hasPhone));
  }
  if (filters.hasChatbotRequests !== undefined) {
    // Any status (frontend Q9).
    const exists = Prisma.sql`EXISTS (SELECT 1 FROM "chatbot_requests" cr WHERE cr."tenantId" = ${tenantId} AND cr."customerId" = c."id")`;
    conditions.push(
      filters.hasChatbotRequests ? exists : Prisma.sql`NOT ${exists}`,
    );
  }
  return conditions;
}

/**
 * Customer-level WHERE conditions (on alias `c`): tenant, `search` (§4.6),
 * `createdFrom/To` (§4.2), pets (§4.3), location (§4.4), commercial (§4.5).
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
  if (filters.createdFrom) {
    conditions.push(
      Prisma.sql`c."createdAt" >= ${utcWall(filters.createdFrom)}`,
    );
  }
  if (filters.createdTo) {
    conditions.push(Prisma.sql`c."createdAt" <= ${utcWall(filters.createdTo)}`);
  }
  conditions.push(...petConditions(tenantId, filters));
  if (hasLocationFilters(filters)) {
    // Any address of the customer (frontend Q8).
    conditions.push(
      Prisma.sql`EXISTS (SELECT 1 FROM "customer_addresses" a WHERE ${matchingAddressesWhere(tenantId, Prisma.sql`c."id"`, filters)})`,
    );
  }
  conditions.push(...commercialConditions(tenantId, filters));
  return conditions;
}

const DAY_MS = 86_400_000;

/**
 * Metric WHERE conditions over the metric columns of `alias` (§4.1, §4.2).
 * `metrics` carries the request's cut-off (00:00Z of the local today) and
 * timezone; `null` (no `read:Sale`) never reaches here with metric filters
 * (§10.1 rejects them first), so it yields no condition.
 */
export function metricFilterConditions(
  filters: CustomerListingFilters,
  alias: string,
  metrics: CustomersListingReadInput['metrics'],
): Prisma.Sql[] {
  if (!metrics) return [];
  const col = (name: string) => Prisma.raw(`${alias}."${name}"`);
  const conditions: Prisma.Sql[] = [];
  const range = (column: string, min?: number, max?: number) => {
    if (min !== undefined)
      conditions.push(Prisma.sql`${col(column)} >= ${min}`);
    if (max !== undefined)
      conditions.push(Prisma.sql`${col(column)} <= ${max}`);
  };
  const instants = (column: string, from?: Date, to?: Date) => {
    if (from) conditions.push(Prisma.sql`${col(column)} >= ${utcWall(from)}`);
    if (to) conditions.push(Prisma.sql`${col(column)} <= ${utcWall(to)}`);
  };

  if (filters.hasDebt !== undefined) {
    conditions.push(
      filters.hasDebt
        ? Prisma.sql`${col('openDebtCents')} > 0`
        : Prisma.sql`${col('openDebtCents')} = 0`,
    );
  }
  range('openDebtCents', filters.openDebtMin, filters.openDebtMax);
  if (filters.hasOverdue !== undefined) {
    conditions.push(
      filters.hasOverdue
        ? Prisma.sql`${col('overdueCount')} > 0`
        : Prisma.sql`${col('overdueCount')} = 0`,
    );
  }
  if (filters.overdueMoreThanDays !== undefined) {
    // Strict (frontend Q6): the oldest overdue due DAY is before
    // localToday − N. `overdueBefore` is 00:00Z of the local today, and the
    // due day is the UTC date of `dueDate`, so N = 30 on 26/11 → due on 26/10
    // or earlier.
    const bound = new Date(
      metrics.overdueBefore.getTime() - filters.overdueMoreThanDays * DAY_MS,
    );
    conditions.push(
      Prisma.sql`${col('oldestOverdueDueDate')} < ${utcWall(bound)}`,
    );
  }
  instants(
    'oldestOverdueDueDate',
    filters.oldestOverdueFrom,
    filters.oldestOverdueTo,
  );
  range('totalSoldCents', filters.totalSoldMin, filters.totalSoldMax);
  range('salesCount', filters.salesCountMin, filters.salesCountMax);
  // `averageTicketCents` is NULL without sales: never inside a range.
  range(
    'averageTicketCents',
    filters.averageTicketMin,
    filters.averageTicketMax,
  );
  instants('lastPurchaseAt', filters.lastPurchaseFrom, filters.lastPurchaseTo);
  if (filters.noPurchaseMoreThanDays !== undefined) {
    // Never bought, or the LOCAL date of the last purchase is before
    // localToday − N: the instant is before that local day's midnight.
    const day = new Date(
      metrics.overdueBefore.getTime() - filters.noPurchaseMoreThanDays * DAY_MS,
    )
      .toISOString()
      .slice(0, 10);
    const localMidnightUtc = Prisma.sql`((${day}::date::timestamp AT TIME ZONE ${metrics.timeZone}) AT TIME ZONE 'UTC')`;
    conditions.push(
      Prisma.sql`(${col('lastPurchaseAt')} IS NULL OR ${col('lastPurchaseAt')} < ${localMidnightUtc})`,
    );
  }
  return conditions;
}

/** True when a metric filter forces computing metrics before paging. */
export function hasMetricFilters(filters: CustomerListingFilters): boolean {
  return METRIC_FILTER_PARAMS.some((key) => filters[key] !== undefined);
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

/**
 * customers-bulk-actions — the internal bulk-selection id conditions (on
 * alias `c`). Nothing for the listing (`ids` absent) or an empty exclusion.
 */
function idConditions(ids: CustomerListingIdConditions | undefined) {
  const conditions: Prisma.Sql[] = [];
  if (ids?.include) {
    conditions.push(Prisma.sql`c."id" = ANY (${ids.include}::text[])`);
  }
  if (ids?.exclude && ids.exclude.length > 0) {
    conditions.push(Prisma.sql`c."id" <> ALL (${ids.exclude}::text[])`);
  }
  return conditions;
}

function candidatesCte(
  tenantId: string,
  filters: CustomerListingFilters,
  ids?: CustomerListingIdConditions,
): Prisma.Sql {
  const columns = Prisma.raw(
    CUSTOMER_COLUMNS.map((column) => `c."${column}"`).join(', '),
  );
  const conditions = [
    ...customerFilterConditions(tenantId, filters),
    ...idConditions(ids),
  ];
  return Prisma.sql`c AS (
    SELECT ${columns}, ${viaPetOnlyColumn(filters)} AS "viaPetOnly"
    FROM "customers" c
    WHERE ${Prisma.join(conditions, ' AND ')}
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
        ${whereClause(metricFilterConditions(input.filters, 'r', metrics))}
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

  // §4.4: the oldest address matching every active location filter.
  const location = hasLocationFilters(input.filters);
  const matchedAddressSelect = location
    ? Prisma.sql`, ma."id" AS "matchedAddressId"`
    : Prisma.empty;
  const matchedAddressJoin = location
    ? Prisma.sql`LEFT JOIN LATERAL (
        SELECT a."id" FROM "customer_addresses" a
        WHERE ${matchingAddressesWhere(tenantId, Prisma.sql`pg."id"`, input.filters)}
        ORDER BY a."createdAt" ASC, a."id" ASC
        LIMIT 1
      ) ma ON true`
    : Prisma.empty;

  const customerSelect = Prisma.raw(
    CUSTOMER_COLUMNS.map((column) => `pg."${column}"`).join(', '),
  );

  return Prisma.sql`
    WITH ${candidatesCte(tenantId, input.filters, input.ids)},
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
      ${matchedAddressSelect}
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
    ${matchedAddressJoin}
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
  const cte = candidatesCte(tenantId, input.filters, input.ids);
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
    ${whereClause(metricFilterConditions(input.filters, 'r', input.metrics))}`;
}
