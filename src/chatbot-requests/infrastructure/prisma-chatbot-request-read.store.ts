/**
 * Prisma adapter of `ChatbotRequestReadStore` (unit 4, contract §3.8, §10.1).
 *
 * Hot path, the grouped inbox: the page of groups comes from the denormalized
 * `chatbot_customer_groups` through `(tenantId, mostUrgentAt, customerKey)`
 * and each group's rows from `(tenantId, customerKey, status)` in one LATERAL
 * join, so there is no GROUP BY at read time. The only aggregate is the
 * resolved/cancelled tabs, which group the bounded 7-day window of closed rows
 * (there is no group table for closed requests).
 *
 * Every statement names `tenantId` itself; the tenant comes from CLS. Dates go
 * as `Date` parameters, like the writers do.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type {
  AuditRecord,
  ChatbotRequestReadStore,
  CustomerRecord,
  DetailRecord,
  GroupRecord,
  HistoryQuery,
  InboxCounts,
  InboxFilters,
  InboxTab,
  OrderRecord,
  RequestRecord,
} from '../application/chatbot-request-reads.service';
import { readDecision } from './chatbot-request-decision.reader';
import { LAST_RELEASED, readWindowWarningMinutes } from './chatbot-sla-policy';
import { assignableUserWhere } from './assignable-users';
import { phoneLookupPairs } from '../domain/canonical-phone';
import { closedWindowCutoff } from '../domain/staff-inbox';
import { windowClosingSoonRange } from '../domain/window-closing-soon';
import { actorDisplayName } from '../domain/actor-display-name';
import { MERGEABLE_SUBTYPES } from '../domain/chatbot-request.commands';
import type { CandidateRecord } from '../application/chatbot-request-reads.service';

/** Requests inside one group of the grouped inbox (§3.8). */
const GROUP_ROWS = 10;
const MERGE_CANDIDATES = 20;
const OTHER_OPEN = 20;
const LINK_CANDIDATES = 10;

const OPEN = Prisma.sql`r."status" IN ('NEW', 'IN_PROGRESS')`;
const URGENCY = Prisma.sql`(CASE WHEN r."status" = 'NEW' THEN r."claimDeadlineAt" ELSE r."resolveDeadlineAt" END)`;
/**
 * S8 columns, each guarded by a CASE so PostgreSQL evaluates the correlated
 * subquery only for the rows that need it (no extra round trip, no N+1):
 *
 *   mergedInto           the SOURCE side of the staff merge (SUPERSEDED rows):
 *                        `{id, folio}` out of the MERGED event's data, via the
 *                        `(tenantId, requestId, createdAt)` events index. Only
 *                        those two keys are projected, never the whole `data`.
 *   lastReleasedAt       start of the claim clock's cycle (NEW rows only; the
 *                        same expression the sweep uses).
 *   zoneHasValidation    DELIVERY_ZONE rows: the zone request has a validation
 *                        (the detail's `zoneImpact` exists exactly then). One
 *                        primary-key lookup.
 */
const MERGED_INTO = Prisma.sql`(CASE WHEN r."cancelReason" = 'SUPERSEDED' THEN (
  SELECT jsonb_build_object('id', e."data" ->> 'intoRequestId', 'folio', e."data" -> 'intoFolio')
  FROM "chatbot_request_events" e
  WHERE e."tenantId" = r."tenantId" AND e."requestId" = r."id"
    AND e."type" = 'MERGED' AND e."data" ->> 'role' = 'SOURCE'
  ORDER BY e."createdAt" DESC LIMIT 1) END)`;
const LAST_RELEASED_NEW = Prisma.sql`(CASE WHEN r."status" = 'NEW' THEN ${LAST_RELEASED} END)`;
const ZONE_HAS_VALIDATION = Prisma.sql`(CASE WHEN r."subtype" = 'DELIVERY_ZONE' THEN EXISTS (
  SELECT 1 FROM "delivery_zone_requests" z
  WHERE z."tenantId" = r."tenantId" AND z."id" = r."deliveryZoneRequestId"
    AND z."validationId" IS NOT NULL) END)`;
/**
 * S12 `unreadCustomerMessages`: the CUSTOMER messages of the request's chat
 * after the conversation's staff-read marker (`lastStaffReadSeq`, moved by
 * `GET …/conversation`). Open requests only (a closed one waits for nobody);
 * the CASE keeps the subquery off every other row. A correlated scalar subquery
 * in the page's own statement: one conversation lookup by its unique
 * `(tenantId, conversationRef)` index plus an index range scan over the partial
 * index `conversation_messages_customer_seq_idx`, per row of the page, with no
 * extra round trip (no N+1).
 */
const UNREAD_CUSTOMER_MESSAGES = Prisma.sql`(CASE WHEN r."conversationRef" IS NOT NULL
    AND r."status" IN ('NEW', 'IN_PROGRESS') THEN (
  SELECT count(*)::int FROM "chatbot_conversations" cv
  JOIN "conversation_messages" cm
    ON cm."conversationId" = cv."id" AND cm."seq" > cv."lastStaffReadSeq"
   AND cm."author" = 'CUSTOMER'
  WHERE cv."tenantId" = r."tenantId" AND cv."conversationRef" = r."conversationRef"
    AND cm."tenantId" = r."tenantId") ELSE 0 END)`;
/**
 * Unit 11 (§12.4 `liveSession`): the newest session of a conversation request,
 * one correlated scalar subquery per field, all served by the index
 * `(tenantId, requestId, epoch DESC)` and kept off every other row by the CASE.
 * An ENDED session on an open request reads as WAITING (reverted or released).
 */
const LIVE_LATEST = Prisma.sql`(SELECT s."epoch" FROM "chatbot_live_sessions" s
  WHERE s."tenantId" = r."tenantId" AND s."requestId" = r."id"
  ORDER BY s."epoch" DESC LIMIT 1)`;
const live = (column: string) =>
  Prisma.sql`(CASE WHEN r."kind" = 'CONVERSATION' THEN (SELECT ${Prisma.raw(column)}
    FROM "chatbot_live_sessions" s
    WHERE s."tenantId" = r."tenantId" AND s."requestId" = r."id"
    ORDER BY s."epoch" DESC LIMIT 1) END)`;
const LIVE_STATE = Prisma.sql`(CASE WHEN r."kind" <> 'CONVERSATION' THEN NULL ELSE (SELECT
    CASE WHEN s."state" <> 'ENDED' THEN s."state"
         WHEN r."status" IN ('NEW', 'IN_PROGRESS') THEN 'WAITING'
         ELSE 'ENDED' END
  FROM "chatbot_live_sessions" s
  WHERE s."tenantId" = r."tenantId" AND s."requestId" = r."id"
  ORDER BY s."epoch" DESC LIMIT 1) END)`;
const LIVE_LAST_CUSTOMER = Prisma.sql`(CASE WHEN r."kind" = 'CONVERSATION' AND ${LIVE_LATEST} IS NOT NULL THEN (
  SELECT cv."lastCustomerMessageAt" FROM "chatbot_conversations" cv
  WHERE cv."tenantId" = r."tenantId" AND cv."conversationRef" = r."conversationRef") END)`;
const LIVE_ACTIVE_AT = live('s."activeAt"');
const COLUMNS = Prisma.sql`
  r."id", r."folio", r."kind"::text AS "kind", r."subtype"::text AS "subtype",
  r."status"::text AS "status", r."version", r."customerKey", r."customerId",
  r."phoneCountryCode", r."phone", r."assigneeUserId", r."assigneeDisplayName",
  r."claimedAt", r."claimDeadlineAt", r."resolveDeadlineAt", r."overdueAt",
  r."whatsappWindowClosesAt", r."scheduledFor", r."requiresTemplateAtStart",
  r."needsReschedule", r."scheduleVersion", r."summary", r."createdAt", r."closedAt",
  r."resolvedByActorId", r."resolvedByDisplayName", ${URGENCY} AS "urgencyAt",
  r."cancelReason"::text AS "cancelReason",
  r."staffCancelReason"::text AS "staffCancelReason",
  ${MERGED_INTO} AS "mergedInto",
  ${LAST_RELEASED_NEW} AS "lastReleasedAt",
  ${ZONE_HAS_VALIDATION} AS "zoneHasValidation",
  ${UNREAD_CUSTOMER_MESSAGES} AS "unreadCustomerMessages",
  ${LIVE_STATE} AS "liveSessionState",
  ${live('s."epoch"')} AS "liveHandoffEpoch",
  ${live('s."lastStaffActivityAt"')} AS "liveLastStaffActivityAt",
  ${live('s."startedAt"')} AS "liveStartedAt",
  ${LIVE_ACTIVE_AT} AS "liveActiveAt",
  ${LIVE_LAST_CUSTOMER} AS "liveLastCustomerMessageAt"`;
/**
 * S9: open requests of the group's customer with `overdueAt` set, exact. A
 * correlated scalar subquery in the page CTE: it runs once per group of the
 * page (at most limit + 1), over the customer's few open rows through
 * `(tenantId, customerKey, status)`, in the same statement (no extra round trip,
 * no N+1, no GROUP BY). Not narrowed by the filters, like `openCount`. The
 * stored `hasOverdue` flag is not used: it is a hint, and this must be exact.
 */
const OVERDUE_COUNT = Prisma.sql`(SELECT count(*)::int FROM "chatbot_requests" o
  WHERE o."tenantId" = g."tenantId" AND o."customerKey" = g."customerKey"
    AND o."status" IN ('NEW', 'IN_PROGRESS') AND o."overdueAt" IS NOT NULL)`;
const OPEN_ORDER = Prisma.sql`ORDER BY "urgencyAt" ASC NULLS LAST, r."createdAt" ASC, r."id" ASC`;
const CLOSED_ORDER = Prisma.sql`ORDER BY r."closedAt" DESC, r."id" DESC`;

/**
 * Accent and case folding of a customer name in SQL. Built-in and immutable
 * (no extension: pg_trgm and unaccent are not installed here); it mirrors
 * `foldText` for the accents Spanish names use.
 */
const FOLD_FROM = 'áàäâãéèëêíìïîóòöôõúùüûñçýÿ';
const FOLD_TO = 'aaaaaeeeeiiiiooooouuuuncyy';
const FOLDED_NAME = Prisma.sql`lower(translate(c."firstName" || ' ' || coalesce(c."lastName", ''),
  ${FOLD_FROM + FOLD_FROM.toUpperCase()}, ${FOLD_TO + FOLD_TO}))`;

/** `q` as a predicate on alias `r` (§3.8): folio, phone digits or customer name. */
function searchPredicate(
  search: NonNullable<InboxFilters['search']>,
  tenantId: string,
): Prisma.Sql {
  switch (search.kind) {
    case 'folio':
      return Prisma.sql`r."folio" = ${search.folio}`;
    case 'phone':
      // `unknown:<id>` keys hold a row id, never a phone.
      return Prisma.sql`r."customerKey" LIKE ${`%${search.digits}%`} AND r."customerKey" NOT LIKE 'unknown:%'`;
    case 'name':
      return Prisma.sql`r."customerId" IN (
        SELECT c."id" FROM "customers" c
        WHERE c."tenantId" = ${tenantId}
          AND ${Prisma.join(
            search.tokens.map(
              (token) => Prisma.sql`${FOLDED_NAME} LIKE ${`%${token}%`}`,
            ),
            ' AND ',
          )})`;
  }
}

/**
 * The merge-candidate rule: same customer, same subtype, same non-null
 * conversation (`request.merged` names one), open, not itself. A NULL
 * conversation on the source matches nothing (`= NULL` is never true).
 */
const mergeCandidateWhere = (
  tenantId: string,
  id: string,
  customerKey: string,
  subtype: string,
) => Prisma.sql`r."tenantId" = ${tenantId} AND r."customerKey" = ${customerKey}
  AND ${OPEN} AND r."id" <> ${id}
  AND r."subtype" = ${subtype}::"ChatbotRequestSubtype"
  AND r."conversationRef" = (
    SELECT s."conversationRef" FROM "chatbot_requests" s
    WHERE s."tenantId" = ${tenantId} AND s."id" = ${id})`;

const and = (parts: Prisma.Sql[]) => Prisma.join(parts, ' AND ');
const asDate = (part: string | null) => new Date(part as string);

/**
 * "Ventana por cerrar" (S11, T7g): an OPEN request whose WhatsApp window closes
 * within the tenant's `windowWarningMinutes`, `(now, now + warning]`. The
 * bounds come from `windowClosingSoonRange`, the same function the per-row
 * boolean (`isWindowClosingSoon`) uses, so the filter, `/counts` and the row
 * cannot drift. Zero minutes is an empty range: the warning is off. Served by
 * `chatbot_requests_open_window_idx` `(tenantId, whatsappWindowClosesAt)`.
 */
const windowClosingSoon = (now: Date, warningMinutes: number) => {
  const { after, upTo } = windowClosingSoonRange(now, warningMinutes);
  return Prisma.sql`${OPEN} AND r."whatsappWindowClosesAt" > ${after} AND r."whatsappWindowClosesAt" <= ${upTo}`;
};

/** Tab and filters as predicates on alias `r` (open tabs hit the partial indexes). */
function inboxPredicates(
  tab: InboxTab,
  filters: InboxFilters,
  userId: string,
  now: Date,
  cutoff: Date,
  windowWarningMinutes: number | undefined,
): Prisma.Sql[] {
  const parts: Prisma.Sql[] = [];
  if (tab === 'open' || tab === 'scheduled') parts.push(OPEN);
  else {
    const status = tab === 'resolved' ? 'RESOLVED' : 'CANCELLED';
    parts.push(
      Prisma.sql`r."status" = ${status}::"ChatbotRequestStatus" AND r."closedAt" >= ${cutoff}`,
    );
  }
  if (tab === 'scheduled') parts.push(Prisma.sql`r."scheduledFor" IS NOT NULL`);
  if (filters.subtype) {
    parts.push(
      Prisma.sql`r."subtype" = ${filters.subtype}::"ChatbotRequestSubtype"`,
    );
  }
  const { assignee } = filters;
  if (assignee?.kind === 'me') {
    parts.push(Prisma.sql`r."assigneeUserId" = ${userId}`);
  } else if (assignee?.kind === 'user') {
    parts.push(Prisma.sql`r."assigneeUserId" = ${assignee.id}`);
  } else if (assignee?.kind === 'unassigned') {
    parts.push(Prisma.sql`r."assigneeUserId" IS NULL`);
  }
  if (filters.overdue) parts.push(Prisma.sql`r."overdueAt" IS NOT NULL`);
  if (filters.windowClosingSoon) {
    // The service reads the minutes once per call and hands them over; no
    // default here, so a caller that forgets fails instead of drifting.
    if (windowWarningMinutes === undefined) {
      throw new Error(
        'windowClosingSoon needs the tenant windowWarningMinutes',
      );
    }
    parts.push(windowClosingSoon(now, windowWarningMinutes));
  }
  return parts;
}

/** Keyset predicate after `(urgency, createdAt, id)` with NULL urgency last. */
function afterOpenCursor(cursor: Array<string | null>): Prisma.Sql {
  const [urgency, createdAt, id] = cursor;
  const tail = Prisma.sql`(r."createdAt", r."id") > (${asDate(createdAt)}, ${id})`;
  return urgency === null
    ? Prisma.sql`(${URGENCY} IS NULL AND ${tail})`
    : Prisma.sql`(${URGENCY} > ${asDate(urgency)} OR ${URGENCY} IS NULL OR (${URGENCY} = ${asDate(urgency)} AND ${tail}))`;
}

const beforeClosedCursor = (cursor: Array<string | null>) =>
  Prisma.sql`(r."closedAt", r."id") < (${asDate(cursor[0])}, ${cursor[1]})`;

@Injectable()
export class PrismaChatbotRequestReadStore implements ChatbotRequestReadStore {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private get db() {
    return this.tenantPrisma.getClient();
  }

  tenantId(): string {
    return this.tenantPrisma.getTenantId();
  }

  async groups(q: {
    tab: InboxTab;
    filters: InboxFilters;
    userId: string;
    now: Date;
    cutoff: Date;
    limit: number;
    cursor: Array<string | null> | null;
    windowWarningMinutes?: number;
  }): Promise<GroupRecord[]> {
    const t = this.tenantId();
    const preds = inboxPredicates(
      q.tab,
      q.filters,
      q.userId,
      q.now,
      q.cutoff,
      q.windowWarningMinutes,
    );
    if (q.filters.search) preds.push(searchPredicate(q.filters.search, t));
    const closed = q.tab === 'resolved' || q.tab === 'cancelled';
    const rows = closed
      ? await this.closedGroups(t, preds, q)
      : await this.openGroups(t, preds, q);
    const groups = new Map<string, GroupRecord>();
    for (const {
      total,
      mostUrgentAt,
      openCount,
      overdueCount,
      lastClosedAt,
      ...row
    } of rows) {
      // SAFETY: the LATERAL select lists exactly the `RequestRecord` columns.
      const request = row as unknown as RequestRecord;
      const group = groups.get(request.customerKey) ?? {
        customerKey: request.customerKey,
        mostUrgentAt,
        openCount,
        overdueCount,
        lastClosedAt,
        moreRequests: 0,
        requests: [],
      };
      group.requests.push(request);
      group.moreRequests = total - group.requests.length;
      groups.set(request.customerKey, group);
    }
    return [...groups.values()];
  }

  private openGroups(
    t: string,
    preds: Prisma.Sql[],
    q: { limit: number; cursor: Array<string | null> | null; tab: InboxTab },
  ) {
    const filtered = preds.length > 1 || q.tab === 'scheduled';
    const [at, key] = q.cursor ?? [];
    const cursor = !q.cursor
      ? Prisma.empty
      : at === null
        ? Prisma.sql`AND g."mostUrgentAt" IS NULL AND g."customerKey" > ${key}`
        : Prisma.sql`AND ((g."mostUrgentAt", g."customerKey") > (${asDate(at)}, ${key}) OR g."mostUrgentAt" IS NULL)`;
    const exists = filtered
      ? Prisma.sql`AND EXISTS (SELECT 1 FROM "chatbot_requests" r
          WHERE r."tenantId" = g."tenantId" AND r."customerKey" = g."customerKey"
            AND ${and(preds)})`
      : Prisma.empty;
    return this.db.$queryRaw<GroupRow[]>(Prisma.sql`
      WITH page AS (
        SELECT g."customerKey", g."mostUrgentAt", g."openCount",
               ${OVERDUE_COUNT} AS "overdueCount"
        FROM "chatbot_customer_groups" g
        WHERE g."tenantId" = ${t} ${cursor} ${exists}
        ORDER BY g."mostUrgentAt" ASC NULLS LAST, g."customerKey" ASC
        LIMIT ${q.limit + 1})
      SELECT p."mostUrgentAt", p."openCount", p."overdueCount", NULL::timestamp AS "lastClosedAt", x.*
      FROM page p
      CROSS JOIN LATERAL (
        SELECT ${COLUMNS}, (count(*) OVER ())::int AS "total"
        FROM "chatbot_requests" r
        WHERE r."tenantId" = ${t} AND r."customerKey" = p."customerKey" AND ${and(preds)}
        ${OPEN_ORDER} LIMIT ${GROUP_ROWS}) x
      ORDER BY p."mostUrgentAt" ASC NULLS LAST, p."customerKey" ASC,
               x."urgencyAt" ASC NULLS LAST, x."createdAt" ASC, x."id" ASC`);
  }

  private closedGroups(
    t: string,
    preds: Prisma.Sql[],
    q: { limit: number; cursor: Array<string | null> | null },
  ) {
    const [at, key] = q.cursor ?? [];
    const having = q.cursor
      ? Prisma.sql`HAVING (max(r."closedAt") < ${asDate(at as string)}
          OR (max(r."closedAt") = ${asDate(at as string)} AND r."customerKey" > ${key}))`
      : Prisma.empty;
    return this.db.$queryRaw<GroupRow[]>(Prisma.sql`
      WITH page AS (
        SELECT r."customerKey", max(r."closedAt") AS "lastClosedAt"
        FROM "chatbot_requests" r
        WHERE r."tenantId" = ${t} AND ${and(preds)}
        GROUP BY r."customerKey" ${having}
        ORDER BY max(r."closedAt") DESC, r."customerKey" ASC
        LIMIT ${q.limit + 1})
      SELECT NULL::timestamp AS "mostUrgentAt", 0 AS "openCount", 0 AS "overdueCount", p."lastClosedAt", x.*
      FROM page p
      CROSS JOIN LATERAL (
        SELECT ${COLUMNS}, (count(*) OVER ())::int AS "total"
        FROM "chatbot_requests" r
        WHERE r."tenantId" = ${t} AND r."customerKey" = p."customerKey" AND ${and(preds)}
        ${CLOSED_ORDER} LIMIT ${GROUP_ROWS}) x
      ORDER BY p."lastClosedAt" DESC, p."customerKey" ASC, x."closedAt" DESC, x."id" DESC`);
  }

  /**
   * The tenant's `windowWarningMinutes`: one primary-key lookup, called by the
   * service at most once per request (never per row).
   */
  windowWarningMinutes(): Promise<number> {
    return readWindowWarningMinutes(this.db, this.tenantId());
  }

  async listByCustomer(q: {
    customerKey: string;
    tab: InboxTab;
    filters: InboxFilters;
    userId: string;
    now: Date;
    cutoff: Date;
    limit: number;
    cursor: Array<string | null> | null;
    windowWarningMinutes?: number;
  }): Promise<RequestRecord[]> {
    const closed = q.tab === 'resolved' || q.tab === 'cancelled';
    const preds = [
      Prisma.sql`r."customerKey" = ${q.customerKey}`,
      ...inboxPredicates(
        q.tab,
        q.filters,
        q.userId,
        q.now,
        q.cutoff,
        q.windowWarningMinutes,
      ),
    ];
    // The same `q` predicate as the groups (R12 was decided by the service).
    if (q.filters.search) {
      preds.push(searchPredicate(q.filters.search, this.tenantId()));
    }
    if (q.cursor) {
      preds.push(
        closed ? beforeClosedCursor(q.cursor) : afterOpenCursor(q.cursor),
      );
    }
    return this.db.$queryRaw<RequestRecord[]>(Prisma.sql`
      SELECT ${COLUMNS} FROM "chatbot_requests" r
      WHERE r."tenantId" = ${this.tenantId()} AND ${and(preds)}
      ${closed ? CLOSED_ORDER : OPEN_ORDER} LIMIT ${q.limit + 1}`);
  }

  async counts(userId: string, now: Date): Promise<InboxCounts> {
    const t = this.tenantId();
    const warningMinutes = await readWindowWarningMinutes(this.db, t);
    const open = (extra: Prisma.Sql) => Prisma.sql`(
      SELECT count(*)::int FROM "chatbot_requests" r
      WHERE r."tenantId" = ${t} AND ${OPEN} AND ${extra})`;
    // S8: closed in the last 7 days, the same D17 window the resolved and
    // cancelled tabs use, so the number matches the tab. Wall clock, tenant
    // scoped, served by the partial history index (tenantId, closedAt DESC).
    const cutoff = closedWindowCutoff(now);
    const closed7d = (status: 'RESOLVED' | 'CANCELLED') => Prisma.sql`(
      SELECT count(*)::int FROM "chatbot_requests" r
      WHERE r."tenantId" = ${t} AND r."status" = ${status}::"ChatbotRequestStatus"
        AND r."closedAt" >= ${cutoff})`;
    const [row] = await this.db.$queryRaw<InboxCounts[]>(Prisma.sql`
      SELECT
        (SELECT count(*)::int FROM "chatbot_requests" r
          WHERE r."tenantId" = ${t} AND r."status" = 'NEW') AS "new",
        (SELECT count(*)::int FROM "chatbot_requests" r
          WHERE r."tenantId" = ${t} AND r."status" = 'IN_PROGRESS') AS "inProgress",
        (SELECT count(*)::int FROM "chatbot_requests" r
          WHERE r."tenantId" = ${t} AND r."status" = 'IN_PROGRESS'
            AND r."assigneeUserId" = ${userId}) AS "mine",
        ${open(Prisma.sql`r."overdueAt" IS NOT NULL`)} AS "overdue",
        (SELECT count(*)::int FROM "chatbot_requests" r
          WHERE r."tenantId" = ${t}
            AND ${windowClosingSoon(now, warningMinutes)}) AS "windowClosingSoon",
        ${open(Prisma.sql`r."scheduledFor" IS NOT NULL`)} AS "scheduled",
        ${open(Prisma.sql`r."needsReschedule"`)} AS "needsReschedule",
        ${closed7d('RESOLVED')} AS "resolved7d",
        ${closed7d('CANCELLED')} AS "cancelled7d",
        (SELECT count(*)::int FROM "chatbot_customer_groups" g
          WHERE g."tenantId" = ${t}) AS "openGroups",
        ${open(Prisma.sql`r."assigneeUserId" IS NULL`)} AS "unassigned"`);
    return row;
  }

  history(q: HistoryQuery): Promise<RequestRecord[]> {
    const preds = [
      Prisma.sql`r."status" IN ('RESOLVED', 'CANCELLED')`,
      Prisma.sql`r."closedAt" < ${q.cutoff}`,
    ];
    if (q.subtype) {
      preds.push(
        Prisma.sql`r."subtype" = ${q.subtype}::"ChatbotRequestSubtype"`,
      );
    }
    if (q.resolvedBy)
      preds.push(Prisma.sql`r."resolvedByActorId" = ${q.resolvedBy}`);
    if (q.customerKey)
      preds.push(Prisma.sql`r."customerKey" = ${q.customerKey}`);
    if (q.from && q.to) {
      preds.push(
        Prisma.sql`r."closedAt" >= ${q.from} AND r."closedAt" < ${q.to}`,
      );
    }
    if (q.cursor) preds.push(beforeClosedCursor(q.cursor));
    return this.db.$queryRaw<RequestRecord[]>(Prisma.sql`
      SELECT ${COLUMNS} FROM "chatbot_requests" r
      WHERE r."tenantId" = ${this.tenantId()} AND ${and(preds)}
      ${CLOSED_ORDER} LIMIT ${q.limit + 1}`);
  }

  async findDetail(id: string, now: Date): Promise<DetailRecord | null> {
    void now;
    const tenantId = this.tenantId();
    const [request] = await this.db.$queryRaw<DetailRecord['request'][]>(
      Prisma.sql`
      SELECT ${COLUMNS}, r."needs", r."context", r."resolution", r."resolvedAt",
             r."ambiguousCustomer", r."humanDecisionId", r."deliveryZoneRequestId",
             r."receiptEvidenceId"
      FROM "chatbot_requests" r WHERE r."tenantId" = ${tenantId} AND r."id" = ${id}`,
    );
    if (!request) return null;
    // SAFETY: the detail select adds exactly these three link columns.
    const links = request as unknown as {
      humanDecisionId: string | null;
      deliveryZoneRequestId: string | null;
      receiptEvidenceId: string | null;
    };
    const customerId = request.customerId;
    const [
      customer,
      recentOrders,
      otherOpen,
      audit,
      deliveries,
      decision,
      candidates,
      hasMergeCandidate,
    ] = await Promise.all([
      customerId ? this.customers([customerId]) : Promise.resolve([]),
      customerId
        ? this.db.$queryRaw<OrderRecord[]>(Prisma.sql`
              SELECT s."id" AS "saleId", s."folio", s."createdAt", s."totalCents",
                     s."status"::text AS "status",
                     s."paymentStatus"::text AS "paymentStatus"
              FROM "sales" s
              WHERE s."tenantId" = ${tenantId} AND s."customerId" = ${customerId}
                AND s."status" <> 'DRAFT'
              ORDER BY s."createdAt" DESC LIMIT 5`)
        : Promise.resolve([]),
      this.db.$queryRaw<RequestRecord[]>(Prisma.sql`
          SELECT ${COLUMNS} FROM "chatbot_requests" r
          WHERE r."tenantId" = ${tenantId} AND r."customerKey" = ${request.customerKey}
            AND ${OPEN} AND r."id" <> ${id}
          ${OPEN_ORDER} LIMIT ${OTHER_OPEN}`),
      this.auditPage(id, null, 21),
      this.db.chatbotFeedItem.findMany({
        where: { tenantId, requestId: id },
        orderBy: { cursor: 'desc' },
        take: 50,
        select: {
          deliveryId: true,
          type: true,
          createdAt: true,
          outcome: true,
          attemptedAt: true,
        },
      }),
      readDecision(this.db, tenantId, request.subtype, links),
      customerId === null ? this.linkCandidates(request) : Promise.resolve([]),
      this.hasMergeCandidate(request),
    ]);
    return {
      request,
      candidates,
      hasMergeCandidate,
      customer: customer[0] ?? null,
      recentOrders,
      otherOpen,
      decision: decision.decision,
      zoneImpact: decision.zoneImpact,
      audit,
      deliveries: deliveries.map((d) => ({ ...d })),
    };
  }

  /**
   * R1 `link-customer` choices: the tenant's customers whose canonical phone is
   * the request's key, oldest first, at most 10. The match is exact in SQL
   * (`phoneLookupPairs` lists every stored form of the key), so the `LIMIT`
   * only ever cuts the end of an ordered list of real matches.
   */
  private async linkCandidates(
    request: Pick<
      RequestRecord,
      'customerKey' | 'phoneCountryCode' | 'phone' | 'status'
    >,
  ): Promise<CandidateRecord[]> {
    const open = request.status === 'NEW' || request.status === 'IN_PROGRESS';
    if (!open || !request.phone || !request.phoneCountryCode) return [];
    const pairs = phoneLookupPairs(request.phoneCountryCode, request.phone);
    if (pairs.length === 0) return [];
    const tenantId = this.tenantId();
    const found = await this.db.customer.findMany({
      where: { tenantId, OR: pairs },
      select: { id: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: LINK_CANDIDATES,
    });
    const exact = await this.customers(found.map((c) => c.id));
    if (exact.length === 0) return [];
    const orders = await this.db.$queryRaw<
      { customerId: string; lastOrderAt: Date }[]
    >(Prisma.sql`
      SELECT s."customerId", max(s."createdAt") AS "lastOrderAt"
      FROM "sales" s
      WHERE s."tenantId" = ${tenantId}
        AND s."customerId" IN (${Prisma.join(exact.map((c) => c.id))})
        AND s."status" <> 'DRAFT'
      GROUP BY s."customerId"`);
    const lastOrder = new Map(orders.map((o) => [o.customerId, o.lastOrderAt]));
    return exact
      .map((c) => ({ ...c, lastOrderAt: lastOrder.get(c.id) ?? null }))
      .sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() ||
          a.id.localeCompare(b.id),
      );
  }

  /** `MERGE` in `allowedActions` needs at least one candidate (§12.11). */
  private async hasMergeCandidate(
    request: Pick<RequestRecord, 'id' | 'customerKey' | 'subtype' | 'status'>,
  ): Promise<boolean> {
    const open = request.status === 'NEW' || request.status === 'IN_PROGRESS';
    if (!open || !MERGEABLE_SUBTYPES.includes(request.subtype)) return false;
    const [row] = await this.db.$queryRaw<{ found: boolean }[]>(Prisma.sql`
      SELECT EXISTS (
        SELECT 1 FROM "chatbot_requests" r
        WHERE ${mergeCandidateWhere(this.tenantId(), request.id, request.customerKey, request.subtype)}
      ) AS "found"`);
    return row.found;
  }

  async assignableUsers() {
    const users = await this.db.user.findMany({
      where: assignableUserWhere(this.tenantId()),
      select: { id: true, name: true, email: true },
    });
    // Sorted by the name people see (the fallback for an empty name included).
    return users.sort(
      (a, b) =>
        actorDisplayName(a).localeCompare(actorDisplayName(b), 'es') ||
        a.id.localeCompare(b.id),
    );
  }

  /** Unit 8: the rows of the realtime events, one query, tenant-bound. */
  byIds(ids: string[]): Promise<RequestRecord[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.db.$queryRaw<RequestRecord[]>(Prisma.sql`
      SELECT ${COLUMNS} FROM "chatbot_requests" r
      WHERE r."tenantId" = ${this.tenantId()} AND r."id" IN (${Prisma.join(ids)})`);
  }

  async mergeCandidates(id: string): Promise<RequestRecord[] | null> {
    const tenantId = this.tenantId();
    const [source] = await this.db.$queryRaw<
      { customerKey: string; subtype: string; open: boolean }[]
    >(Prisma.sql`
      SELECT r."customerKey", r."subtype"::text AS "subtype", (${OPEN}) AS "open"
      FROM "chatbot_requests" r WHERE r."tenantId" = ${tenantId} AND r."id" = ${id}`);
    if (!source) return null;
    // §12.11: only subtypes without a wrapped table, both requests open.
    if (
      !source.open ||
      !MERGEABLE_SUBTYPES.some((subtype) => subtype === source.subtype)
    ) {
      return [];
    }
    return this.db.$queryRaw<RequestRecord[]>(Prisma.sql`
      SELECT ${COLUMNS} FROM "chatbot_requests" r
      WHERE ${mergeCandidateWhere(tenantId, id, source.customerKey, source.subtype)}
      ${OPEN_ORDER} LIMIT ${MERGE_CANDIDATES}`);
  }

  async audit(
    id: string,
    cursor: Array<string | null> | null,
    limit: number,
  ): Promise<AuditRecord[] | null> {
    const exists = await this.db.chatbotRequest.count({
      where: { tenantId: this.tenantId(), id },
    });
    return exists ? this.auditPage(id, cursor, limit + 1) : null;
  }

  private async auditPage(
    requestId: string,
    cursor: Array<string | null> | null,
    take: number,
  ): Promise<AuditRecord[]> {
    const after = cursor
      ? {
          OR: [
            { createdAt: { lt: asDate(cursor[0]) } },
            { createdAt: asDate(cursor[0]), id: { lt: cursor[1] as string } },
          ],
        }
      : {};
    const events = await this.db.chatbotRequestEvent.findMany({
      where: { tenantId: this.tenantId(), requestId, ...after },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
    });
    return events.map((e) => ({
      id: e.id,
      type: e.type,
      actorKind: e.actorKind,
      actorId: e.actorId,
      actorDisplayName: e.actorDisplayName,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      version: e.version,
      data: e.data,
      createdAt: e.createdAt,
    }));
  }

  async customers(ids: string[]): Promise<CustomerRecord[]> {
    const rows = await this.db.customer.findMany({
      where: { tenantId: this.tenantId(), id: { in: ids } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phoneCountryCode: true,
        phone: true,
        isTrusted: true,
        createdAt: true,
        globalPriceList: { select: { id: true, name: true } },
      },
    });
    return rows.map(({ globalPriceList, ...customer }) => ({
      ...customer,
      priceList: globalPriceList,
    }));
  }
}

type GroupRow = RequestRecord & {
  total: number;
  mostUrgentAt: Date | null;
  openCount: number;
  overdueCount: number;
  lastClosedAt: Date | null;
};
