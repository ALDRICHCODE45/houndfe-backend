/**
 * One-time backfill of the legacy human flows into `ChatbotRequest`
 * (human-intervention unit 3, slice 3b; contract §2.4, §2.3, R1, R9). It is an
 * ops tool (`scripts/ops/backfill-chatbot-requests.cjs` loads this compiled
 * module), not a SQL migration: it needs `canonicalPhone`, the R1 linking and
 * the 3a request builder, and it must stay re-runnable.
 *
 * What it wraps, per tenant, for rows that have no wrapping request yet:
 *   - PENDING rows (RESTOCK/EXPIRATION `HumanDecision`, `DeliveryZoneRequest`
 *     waiting on a validation, `ReceiptEvidence`) become NEW requests;
 *   - rows RESOLVED in the last 7 days become RESOLVED requests with the
 *     resolution date and actor copied; older resolved rows are left alone.
 *
 * It is safe while the API is live. Each batch (default 100) is one READ
 * COMMITTED transaction that takes locks in the order of
 * docs/chatbot-requests-model.md:
 *   1. the postal-code advisory locks of the batch (zones only), sorted;
 *   2. the wrapped rows `FOR UPDATE` (id order), re-reading their state and
 *      re-checking that no request wraps them yet (a 3a hook, a legacy resolve
 *      or a second backfill may have got there first);
 *   3. the folio block (one counter statement), after every read;
 *   4. the request rows, `ON CONFLICT DO NOTHING` on the unique wrapped FK;
 *   5. the customer groups, in sorted `customerKey` order, last.
 * The groups are refreshed only after the folio block, so a batch never holds
 * a group lock while waiting for the counter (lock-order rule 1).
 *
 * Requests are built by the 3a code (`requestCreateData`, `linkByPhone`), so
 * folio source, `customerKey`, the R1 ambiguity flag and the summary are the
 * ones a hook writes. The audit event is `CREATED` with `data.backfilled`
 * because the event enum has no `BACKFILLED` member yet (see the constant).
 */
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma, type PrismaClient } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { lockZipCode } from '../../delivery-zones/infrastructure/delivery-zone-persistence';
import { createTenantScopedPrisma } from '../../shared/prisma/tenant-prisma.factory';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { RESTOCK_SOURCE } from '../../human-decisions/domain/restock-request-canonicalizer';
import { actorDisplayName } from '../domain/actor-display-name';
import { computeSla } from '../domain/chatbot-sla';
import { loadSlaPolicy } from './chatbot-sla-policy';
import {
  allocateFolios,
  refreshCustomerGroups,
  type TenantClient,
} from './chatbot-request-writes';
import {
  findReceiptSale,
  humanDecisionWrap,
  linkByPhone,
  receiptWrap,
  requestCreateData,
  zoneRequestWrap,
  type NewWrappedRequest,
  type RequestCreateExtras,
} from './chatbot-request-wrapper';

/** Contract §2.4: the window the tray shows today for resolved decisions. */
export const RECENT_DAYS = 7;
export const DEFAULT_BATCH_SIZE = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
const TX_OPTIONS = { timeout: 60_000, maxWait: 10_000 } as const;

/**
 * The audit event of a backfilled request. `ChatbotRequestEventType` has no
 * `BACKFILLED` member and adding one is a migration, so the event is a
 * `CREATED` one marked `data.backfilled = true`. Switch this constant when
 * the enum grows.
 */
export const BACKFILL_EVENT_TYPE = 'CREATED' as const;

export const SUBTYPES = [
  'RESTOCK',
  'EXPIRATION',
  'DELIVERY_ZONE',
  'TRANSFER_RECEIPT',
] as const;
export type BackfillSubtype = (typeof SUBTYPES)[number];

export interface SubtypeCounts {
  open: number;
  resolved: number;
}

export interface TenantBackfillReport {
  tenantId: string;
  /** Requests to create (dry run) or created (apply), per subtype. */
  create: Record<BackfillSubtype, SubtypeCounts>;
  /** Qualifying rows (pending or recently resolved) that already have one. */
  alreadyWrapped: number;
  /** Of the requests to create: zone requesters that matched >1 customer. */
  ambiguousCustomers: number;
  /** Apply only: rows planned but wrapped or changed before the lock. */
  changedUnderLock: number;
  /** Rejected receipts of the window: they keep no resolution date. */
  undatedRejectedReceipts: number;
  /**
   * Creation date of the oldest PENDING row to wrap (or wrapped), per subtype;
   * `null` when there is none. Unit 7 sizes the SLA burst from the age.
   */
  oldestOpenAt: Record<BackfillSubtype, Date | null>;
  batches: number;
}

export interface BackfillReport {
  applied: boolean;
  /** The clock of this run: ages are measured against it. */
  now: Date;
  cutoff: Date;
  tenants: TenantBackfillReport[];
}

export type FamilyName =
  | 'HUMAN_DECISION'
  | 'DELIVERY_ZONE_REQUEST'
  | 'RECEIPT_EVIDENCE';

export interface BackfillOptions {
  apply: boolean;
  /** Tenants to process; every tenant when omitted. */
  tenantIds?: string[];
  batchSize?: number;
  now?: Date;
  /**
   * Test seam: called inside the batch transaction after the folio block and
   * before the request insert, with the batch's transaction client (lets a
   * test plant a wrapper to reach the `ON CONFLICT DO NOTHING` branch).
   */
  beforeInsert?: (
    tx: TenantClient,
    batch: { tenantId: string; family: FamilyName; ids: string[] },
  ) => Promise<void>;
  /** Test seam: called after a batch is planned and before its transaction. */
  onBatchPlanned?: (batch: {
    tenantId: string;
    family: FamilyName;
    ids: string[];
  }) => Promise<void>;
}

interface Prepared {
  id: string;
  subtype: BackfillSubtype;
  createdAt: Date;
  wrap: NewWrappedRequest;
  resolved?: NonNullable<RequestCreateExtras['resolved']>;
}

interface Candidate {
  id: string;
  createdAt: Date;
  zipCode: string | null;
}

/** Rows read for a batch; `prepare` skips the ids the caller dropped. */
interface LoadedRows {
  ids: string[];
  prepare: (skip: ReadonlySet<string>) => Promise<Prepared[]>;
}

interface Family {
  name: FamilyName;
  /** `FROM` target, aliased `w`. */
  table: Prisma.Sql;
  /** The request column that wraps this table, aliased `cr`. */
  wrappedRef: Prisma.Sql;
  /** The request subtype of a row, as text. */
  subtype: Prisma.Sql;
  /** Pending, or resolved on/after `cutoff` (and wrappable). */
  qualifies: (cutoff: Date) => Prisma.Sql;
  zip: Prisma.Sql;
  /**
   * Reads the rows of `ids` that still qualify. `forUpdate` locks them (apply);
   * a dry run reads without locks.
   */
  load: (
    db: TenantClient,
    tenantId: string,
    ids: string[],
    cutoff: Date,
    forUpdate: boolean,
  ) => Promise<LoadedRows>;
}

const FOR_UPDATE = Prisma.sql`FOR UPDATE OF w`;

// ----------------------------------------------------------- the families

interface DecisionRow {
  id: string;
  createdAt: Date;
  type: 'RESTOCK' | 'EXPIRATION';
  productId: string;
  productName: string;
  variantId: string | null;
  status: string;
  resolvedAt: Date | null;
  resolvedByActorId: string | null;
  resolvedByDisplayName: string | null;
  resolutionAction: string | null;
  restockDays: number | null;
}

const decisionFamily: Family = {
  name: 'HUMAN_DECISION',
  table: Prisma.sql`"human_decisions" w`,
  wrappedRef: Prisma.sql`cr."humanDecisionId"`,
  subtype: Prisma.sql`w."type"::text`,
  zip: Prisma.sql`NULL::text`,
  // Only the chatbot's decisions, like the legacy tray (`RESTOCK_SOURCE`):
  // another source is never wrapped.
  qualifies: (cutoff) => Prisma.sql`(
    w."source" = ${RESTOCK_SOURCE}
    AND (w."status" = 'PENDING'
      OR (w."status" = 'RESOLVED' AND w."resolvedAt" >= ${cutoff})))`,
  load: async (db, tenantId, ids, cutoff, forUpdate) => {
    const rows = await db.$queryRaw<DecisionRow[]>(Prisma.sql`
      SELECT w."id", w."createdAt", w."type"::text AS "type", w."productId",
             w."productName", w."variantId", w."status"::text AS "status",
             w."resolvedAt", w."resolvedByActorId", w."resolvedByDisplayName",
             w."resolutionAction"::text AS "resolutionAction", w."restockDays"
      FROM "human_decisions" w
      WHERE w."tenantId" = ${tenantId} AND w."id" IN (${Prisma.join(ids)})
        AND ${decisionFamily.qualifies(cutoff)}
      ORDER BY w."id"
      ${forUpdate ? FOR_UPDATE : Prisma.empty}`);
    return {
      ids: rows.map((row) => row.id),
      prepare: (skip) =>
        Promise.resolve(prepareDecisions(rows.filter((r) => !skip.has(r.id)))),
    };
  },
};

function prepareDecisions(rows: DecisionRow[]): Prepared[] {
  return rows.map((row): Prepared => {
    const resolved =
      row.status === 'RESOLVED' && row.resolvedAt
        ? {
            resolvedAt: row.resolvedAt,
            resolvedByActorId: row.resolvedByActorId,
            resolvedByDisplayName: row.resolvedByDisplayName,
            resolution: {
              action: row.resolutionAction,
              via: 'BACKFILL',
              ...(row.restockDays === null
                ? {}
                : { restockDays: row.restockDays }),
            },
          }
        : undefined;
    return {
      id: row.id,
      subtype: row.type,
      createdAt: row.createdAt,
      wrap: humanDecisionWrap(row),
      resolved,
    };
  });
}

interface ZoneRow {
  id: string;
  createdAt: Date;
  zipCode: string;
  validationId: string;
  conversationRef: string;
  lastCustomerMessageAt: Date;
  customerPhoneCountryCode: string;
  customerPhone: string;
  status: string;
  resolvedAt: Date | null;
  zoneType: string | null;
  resolutionAction: string | null;
  resolvedByActorId: string | null;
  resolvedByDisplayName: string | null;
}

const zoneFamily: Family = {
  name: 'DELIVERY_ZONE_REQUEST',
  table: Prisma.sql`"delivery_zone_requests" w`,
  wrappedRef: Prisma.sql`cr."deliveryZoneRequestId"`,
  subtype: Prisma.sql`'DELIVERY_ZONE'::text`,
  zip: Prisma.sql`w."zipCode"`,
  // A requester born RESOLVED by an existing zone never waited for a human
  // and has no validation: the 3a hook does not wrap it either.
  qualifies: (cutoff) => Prisma.sql`(
    w."validationId" IS NOT NULL
    AND (w."status" = 'PENDING'
      OR (w."status" = 'RESOLVED' AND w."resolutionSource" = 'VALIDATION'
          AND w."resolvedAt" >= ${cutoff})))`,
  load: async (db, tenantId, ids, cutoff, forUpdate) => {
    const rows = await db.$queryRaw<ZoneRow[]>(Prisma.sql`
      SELECT w."id", w."createdAt", w."zipCode", w."validationId",
             w."conversationRef", w."lastCustomerMessageAt",
             w."customerPhoneCountryCode", w."customerPhone",
             w."status"::text AS "status", w."resolvedAt",
             w."zoneType"::text AS "zoneType",
             v."resolutionAction"::text AS "resolutionAction",
             v."resolvedByActorId", v."resolvedByDisplayName"
      FROM "delivery_zone_requests" w
      LEFT JOIN "delivery_zone_validations" v ON v."id" = w."validationId"
      WHERE w."tenantId" = ${tenantId} AND w."id" IN (${Prisma.join(ids)})
        AND ${zoneFamily.qualifies(cutoff)}
      ORDER BY w."id"
      ${forUpdate ? FOR_UPDATE : Prisma.empty}`);
    return {
      ids: rows.map((row) => row.id),
      prepare: (skip) =>
        prepareZones(
          db,
          tenantId,
          rows.filter((row) => !skip.has(row.id)),
        ),
    };
  },
};

async function prepareZones(
  db: TenantClient,
  tenantId: string,
  rows: ZoneRow[],
): Promise<Prepared[]> {
  const prepared: Prepared[] = [];
  for (const row of rows) {
    // R1, exactly as the creation hook links a requester.
    const link = await linkByPhone(
      db,
      tenantId,
      row.customerPhoneCountryCode,
      row.customerPhone,
    );
    const resolved =
      row.status === 'RESOLVED' && row.resolvedAt
        ? {
            resolvedAt: row.resolvedAt,
            resolvedByActorId: row.resolvedByActorId,
            resolvedByDisplayName: row.resolvedByDisplayName,
            resolution: {
              action:
                row.resolutionAction ??
                (row.zoneType === 'DENIED'
                  ? 'REJECT_DELIVERY_ZONE'
                  : 'APPROVE_DELIVERY_ZONE'),
              via: 'BACKFILL',
              zoneType: row.zoneType,
              validationId: row.validationId,
            },
          }
        : undefined;
    prepared.push({
      id: row.id,
      subtype: 'DELIVERY_ZONE',
      createdAt: row.createdAt,
      wrap: zoneRequestWrap(row, link),
      resolved,
    });
  }
  return prepared;
}

interface ReceiptRow {
  id: string;
  createdAt: Date;
  saleId: string;
  status: string;
  confirmedAt: Date | null;
  confirmedByUserId: string | null;
}

const receiptFamily: Family = {
  name: 'RECEIPT_EVIDENCE',
  table: Prisma.sql`"receipt_evidences" w`,
  wrappedRef: Prisma.sql`cr."receiptEvidenceId"`,
  subtype: Prisma.sql`'TRANSFER_RECEIPT'::text`,
  zip: Prisma.sql`NULL::text`,
  // A rejection stores no date (`markRejected` writes none), so a rejected
  // receipt cannot be placed in the window and is reported, not wrapped.
  qualifies: (cutoff) => Prisma.sql`(
    w."status" = 'PENDING'
    OR (w."status" = 'CONFIRMED' AND w."confirmedAt" >= ${cutoff}))`,
  load: async (db, tenantId, ids, cutoff, forUpdate) => {
    const rows = await db.$queryRaw<ReceiptRow[]>(Prisma.sql`
      SELECT w."id", w."createdAt", w."saleId", w."status"::text AS "status",
             w."confirmedAt", w."confirmedByUserId"
      FROM "receipt_evidences" w
      WHERE w."tenantId" = ${tenantId} AND w."id" IN (${Prisma.join(ids)})
        AND ${receiptFamily.qualifies(cutoff)}
      ORDER BY w."id"
      ${forUpdate ? FOR_UPDATE : Prisma.empty}`);
    return {
      ids: rows.map((row) => row.id),
      prepare: (skip) =>
        prepareReceipts(
          db,
          tenantId,
          rows.filter((row) => !skip.has(row.id)),
        ),
    };
  },
};

async function prepareReceipts(
  db: TenantClient,
  tenantId: string,
  rows: ReceiptRow[],
): Promise<Prepared[]> {
  const sales = new Map<string, Awaited<ReturnType<typeof findReceiptSale>>>();
  for (const row of rows) {
    sales.set(row.id, await findReceiptSale(db, tenantId, row.saleId));
  }
  // M3: the sale names its customer; prove it is a customer of this tenant.
  const customerIds = [
    ...new Set(
      [...sales.values()].flatMap((sale) =>
        sale?.customerId ? [sale.customerId] : [],
      ),
    ),
  ];
  const known = new Set(
    customerIds.length === 0
      ? []
      : (
          await db.customer.findMany({
            where: { tenantId, id: { in: customerIds } },
            select: { id: true },
          })
        ).map((customer) => customer.id),
  );
  const reviewerIds = [
    ...new Set(
      rows.flatMap((row) =>
        row.status === 'CONFIRMED' && row.confirmedByUserId
          ? [row.confirmedByUserId]
          : [],
      ),
    ),
  ];
  const names = new Map(
    reviewerIds.length === 0
      ? []
      : (
          await db.user.findMany({
            where: { id: { in: reviewerIds } },
            select: { id: true, name: true, email: true },
          })
        ).map((user) => [user.id, actorDisplayName(user)] as const),
  );
  return rows.map((row): Prepared => {
    const sale = sales.get(row.id) ?? null;
    const wrap = receiptWrap(
      row,
      sale?.customerId && !known.has(sale.customerId)
        ? { ...sale, customerId: null }
        : sale,
    );
    const name = row.confirmedByUserId
      ? names.get(row.confirmedByUserId)
      : undefined;
    const resolved =
      row.status === 'CONFIRMED' && row.confirmedAt
        ? {
            resolvedAt: row.confirmedAt,
            // The reviewer may have been deleted: then neither is copied.
            resolvedByActorId: name ? row.confirmedByUserId : null,
            resolvedByDisplayName: name ?? null,
            resolution: { action: 'CONFIRM_RECEIPT', via: 'BACKFILL' },
          }
        : undefined;
    return {
      id: row.id,
      subtype: 'TRANSFER_RECEIPT',
      createdAt: row.createdAt,
      wrap,
      resolved,
    };
  });
}

const FAMILIES: readonly Family[] = [decisionFamily, zoneFamily, receiptFamily];

// ---------------------------------------------------------------- the run

function emptyCreate(): Record<BackfillSubtype, SubtypeCounts> {
  return Object.fromEntries(
    SUBTYPES.map((subtype) => [subtype, { open: 0, resolved: 0 }]),
  ) as Record<BackfillSubtype, SubtypeCounts>;
}

export function recentCutoff(now: Date, days = RECENT_DAYS): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

async function countWrapped(
  db: TenantClient,
  tenantId: string,
  family: Family,
  cutoff: Date,
): Promise<number> {
  const [row] = await db.$queryRaw<{ n: number }[]>(Prisma.sql`
    SELECT count(*)::int AS "n" FROM ${family.table}
    WHERE w."tenantId" = ${tenantId} AND ${family.qualifies(cutoff)}
      AND EXISTS (SELECT 1 FROM "chatbot_requests" cr
                  WHERE ${family.wrappedRef} = w."id")`);
  return row.n;
}

async function countUndatedRejected(
  db: TenantClient,
  tenantId: string,
  cutoff: Date,
): Promise<number> {
  const [row] = await db.$queryRaw<{ n: number }[]>(Prisma.sql`
    SELECT count(*)::int AS "n" FROM "receipt_evidences" w
    WHERE w."tenantId" = ${tenantId} AND w."status" = 'REJECTED'
      AND w."createdAt" >= ${cutoff}
      AND NOT EXISTS (SELECT 1 FROM "chatbot_requests" cr
                      WHERE cr."receiptEvidenceId" = w."id")`);
  return row.n;
}

/** Next batch of rows without a request, oldest first, after `after`. */
function planBatch(
  db: TenantClient,
  tenantId: string,
  family: Family,
  cutoff: Date,
  after: { createdAt: Date; id: string } | null,
  limit: number,
): Promise<Candidate[]> {
  return db.$queryRaw<Candidate[]>(Prisma.sql`
    SELECT w."id", w."createdAt", ${family.zip} AS "zipCode"
    FROM ${family.table}
    WHERE w."tenantId" = ${tenantId} AND ${family.qualifies(cutoff)}
      AND NOT EXISTS (SELECT 1 FROM "chatbot_requests" cr
                      WHERE ${family.wrappedRef} = w."id")
      ${
        after
          ? Prisma.sql`AND (w."createdAt", w."id") > (${after.createdAt}, ${after.id})`
          : Prisma.empty
      }
    ORDER BY w."createdAt", w."id"
    LIMIT ${limit}`);
}

/** Ids that already have a request, read as a new statement (new snapshot). */
async function wrappedAmong(
  db: TenantClient,
  tenantId: string,
  family: Family,
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT ${family.wrappedRef} AS "id" FROM "chatbot_requests" cr
    WHERE cr."tenantId" = ${tenantId}
      AND ${family.wrappedRef} IN (${Prisma.join(ids)})`);
  return new Set(rows.map((row) => row.id));
}

function tally(report: TenantBackfillReport, prepared: Prepared[]): void {
  for (const item of prepared) {
    report.create[item.subtype][item.resolved ? 'resolved' : 'open'] += 1;
    const oldest = report.oldestOpenAt[item.subtype];
    if (!item.resolved && (oldest === null || item.createdAt < oldest)) {
      report.oldestOpenAt[item.subtype] = item.createdAt;
    }
    if (item.wrap.link.ambiguousCustomer) report.ambiguousCustomers += 1;
  }
}

/**
 * Writes one batch. Returns the prepared rows that became requests and how
 * many of the planned ids were already wrapped or no longer qualified.
 */
async function applyBatch(
  tx: TenantClient,
  tenantId: string,
  family: Family,
  candidates: Candidate[],
  cutoff: Date,
  beforeInsert: BackfillOptions['beforeInsert'],
): Promise<{ created: Prepared[]; changed: number }> {
  // 1. Postal-code locks first, sorted (lock-order rule 5).
  const zips = [
    ...new Set(
      candidates.flatMap((candidate) =>
        candidate.zipCode ? [candidate.zipCode] : [],
      ),
    ),
  ].sort();
  for (const zip of zips) await lockZipCode(tx, tenantId, zip);

  // 2. Lock the wrapped rows and re-check: their state is re-read under the
  // lock, and the wrapper lookup is a new statement (new READ COMMITTED
  // snapshot), so a request committed since planning is seen.
  const ids = candidates.map((candidate) => candidate.id);
  const loaded = await family.load(tx, tenantId, ids, cutoff, true);
  const wrappedNow = await wrappedAmong(tx, tenantId, family, loaded.ids);
  const prepared = (await loaded.prepare(wrappedNow)).sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
  if (prepared.length === 0) return { created: [], changed: ids.length };

  // 3-4. Folio block after every read, then the requests; DO NOTHING on the
  // unique wrapped FK is the net under the checks above.
  const firstFolio = await allocateFolios(tx, tenantId, prepared.length);
  const requestIds: string[] = prepared.map(() => randomUUID());
  await beforeInsert?.(tx, {
    tenantId,
    family: family.name,
    ids: prepared.map((item) => item.id),
  });
  // Unit 7a (§5.4): open rows get their deadlines from the tenant's settings,
  // counted from the wrapped row's own `createdAt` (an old open row is overdue
  // at once; the sweep sizes that burst). Rows born resolved keep none.
  const policy = await loadSlaPolicy(tx, tenantId, { lock: true });
  const backfillNow = new Date();
  const { count } = await tx.chatbotRequest.createMany({
    data: prepared.map((item, index) => ({
      ...requestCreateData(tenantId, firstFolio + index, item.wrap, {
        id: requestIds[index],
        createdAt: item.createdAt,
        resolved: item.resolved,
      }),
      ...(item.resolved
        ? {}
        : computeSla(
            policy,
            {
              subtype: item.subtype,
              status: 'NEW',
              createdAt: item.createdAt,
              scheduledFor: null,
              lastReleasedAt: null,
              overdueAt: null,
            },
            backfillNow,
          )),
    })),
    skipDuplicates: true,
  });
  let inserted = new Set<string>(requestIds);
  if (count !== prepared.length) {
    inserted = new Set(
      (
        await tx.chatbotRequest.findMany({
          where: { tenantId, id: { in: requestIds } },
          select: { id: true },
        })
      ).map((request) => request.id),
    );
    // A row that was not inserted must be wrapped by someone else.
    const missed = prepared
      .filter((_, index) => !inserted.has(requestIds[index]))
      .map((item) => item.id);
    const covered = await wrappedAmong(tx, tenantId, family, missed);
    if (covered.size !== missed.length) {
      throw new Error('chatbot request backfill lost a row without a wrapper');
    }
  }
  const created = prepared.filter((_, index) =>
    inserted.has(requestIds[index]),
  );
  const createdIds = requestIds.filter((id) => inserted.has(id));
  await tx.chatbotRequestEvent.createMany({
    data: created.map((item, index) => ({
      tenantId,
      requestId: createdIds[index],
      type: BACKFILL_EVENT_TYPE,
      actorKind: 'SYSTEM' as const,
      toStatus: item.resolved ? ('RESOLVED' as const) : ('NEW' as const),
      version: 1,
      data: {
        subtype: item.subtype,
        wrapped: true,
        backfilled: true,
        ...(item.resolved
          ? { resolvedAt: item.resolved.resolvedAt.toISOString() }
          : {}),
      },
    })),
  });

  // 5. Groups last, sorted; only open requests have a group.
  await refreshCustomerGroups(
    tx,
    tenantId,
    created
      .filter((item) => !item.resolved)
      .map((item) => item.wrap.link.customerKey ?? item.wrap.fallbackKey),
  );
  return {
    created,
    changed: ids.length - created.length,
  };
}

type RunOptions = Required<Pick<BackfillOptions, 'apply' | 'batchSize'>> &
  Pick<BackfillOptions, 'onBatchPlanned' | 'beforeInsert'>;

async function runTenant(
  scoped: TenantClient,
  tenantId: string,
  options: RunOptions,
  cutoff: Date,
): Promise<TenantBackfillReport> {
  const report: TenantBackfillReport = {
    tenantId,
    create: emptyCreate(),
    alreadyWrapped: 0,
    ambiguousCustomers: 0,
    changedUnderLock: 0,
    undatedRejectedReceipts: await countUndatedRejected(
      scoped,
      tenantId,
      cutoff,
    ),
    oldestOpenAt: {
      RESTOCK: null,
      EXPIRATION: null,
      DELIVERY_ZONE: null,
      TRANSFER_RECEIPT: null,
    },
    batches: 0,
  };
  for (const family of FAMILIES) {
    report.alreadyWrapped += await countWrapped(
      scoped,
      tenantId,
      family,
      cutoff,
    );
    let after: { createdAt: Date; id: string } | null = null;
    for (;;) {
      const candidates = await planBatch(
        scoped,
        tenantId,
        family,
        cutoff,
        after,
        options.batchSize,
      );
      if (candidates.length === 0) break;
      const last = candidates[candidates.length - 1];
      after = { createdAt: last.createdAt, id: last.id };
      report.batches += 1;
      await options.onBatchPlanned?.({
        tenantId,
        family: family.name,
        ids: candidates.map((candidate) => candidate.id),
      });

      if (options.apply) {
        const { created, changed } = await scoped.$transaction(
          (tx) =>
            applyBatch(
              // SAFETY: the interactive client of the tenant-extended client
              // has the same model delegates as `TenantClient` (the same cast
              // the ambient-transaction service makes); its type only omits
              // the top-level lifecycle methods.
              tx as unknown as TenantClient,
              tenantId,
              family,
              candidates,
              cutoff,
              options.beforeInsert,
            ),
          TX_OPTIONS,
        );
        tally(report, created);
        report.changedUnderLock += changed;
      } else {
        // Dry run: the same reading and R1 linking, no lock and no write.
        const loaded = await family.load(
          scoped,
          tenantId,
          candidates.map((candidate) => candidate.id),
          cutoff,
          false,
        );
        tally(report, await loaded.prepare(new Set()));
      }
      if (candidates.length < options.batchSize) break;
    }
  }
  return report;
}

/**
 * Plans (`apply: false`, writes nothing) or performs the backfill, tenant by
 * tenant. Re-running after `apply` plans and creates 0.
 */
export async function runBackfill(
  prisma: PrismaClient,
  options: BackfillOptions,
): Promise<BackfillReport> {
  const now = options.now ?? new Date();
  const cutoff = recentCutoff(now);
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error('batchSize must be a positive integer');
  }
  const tenantIds = options.tenantIds ?? (await allTenantIds(prisma));

  const cls = new ClsService<TenantClsStore>(
    new AsyncLocalStorage<TenantClsStore>(),
  );
  const scoped = createTenantScopedPrisma(prisma, cls);
  const tenants: TenantBackfillReport[] = [];
  for (const tenantId of tenantIds) {
    tenants.push(
      await cls.runWith(
        { tenantId, userId: 'backfill', isSuperAdmin: false },
        () =>
          runTenant(
            scoped,
            tenantId,
            {
              apply: options.apply,
              batchSize,
              onBatchPlanned: options.onBatchPlanned,
              beforeInsert: options.beforeInsert,
            },
            cutoff,
          ),
      ),
    );
  }
  return { applied: options.apply, now, cutoff, tenants };
}

async function allTenantIds(prisma: PrismaClient): Promise<string[]> {
  const rows = await prisma.tenant.findMany({
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  return rows.map((tenant) => tenant.id);
}

// ------------------------------------------------------------ the invariant

export type MismatchKind =
  | 'MISSING_REQUEST'
  | 'RESOLVED_UNWRAPPED'
  | 'STATE_DISAGREES'
  | 'GROUP_MISMATCH';

export interface Mismatch {
  kind: MismatchKind;
  subtype: string | null;
  /** Wrapped row id, or the (masked) customer key for a group. */
  id: string;
}

export interface TenantInvariantReport {
  tenantId: string;
  /** Wrapped rows still open (PENDING). */
  openWrapped: number;
  /** Open requests that wrap a legacy row. */
  openRequests: number;
  mismatches: Mismatch[];
}

export interface InvariantReport {
  tenants: TenantInvariantReport[];
}

/**
 * `55****78`: the first two and the last two digits of the last ten, never more
 * than 4 digits in total (the rule of `count-duplicate-customer-phones.cjs`);
 * fewer than 6 digits show nothing. An `unknown:<id>` key holds a row id, not a
 * phone, and is kept.
 */
export function maskCustomerKey(key: string): string {
  if (key.startsWith('unknown:')) return key;
  const last = key.replace(/\D/g, '').slice(-10);
  return last.length < 6 ? '****' : `${last.slice(0, 2)}****${last.slice(-2)}`;
}

interface OpenWrappedRow {
  id: string;
  subtype: string;
  requestStatus: string | null;
}

/**
 * §2.1 invariant, read-only: every open wrapped row has exactly one open
 * request (the unique FK gives "one") and the states agree, a row resolved in
 * the last 7 days has a request (`RESOLVED_UNWRAPPED`; older ones are not
 * wrapped by design), and the customer groups match the open requests. A request CANCELLED by the customer leaves
 * its wrapped row PENDING by design, so it is not a mismatch. Runs in one
 * REPEATABLE READ snapshot; under live traffic, re-run before trusting a
 * single stray mismatch.
 */
export async function checkInvariant(
  prisma: PrismaClient,
  options: { tenantIds?: string[]; now?: Date } = {},
): Promise<InvariantReport> {
  const tenantIds = options.tenantIds ?? (await allTenantIds(prisma));
  const cutoff = recentCutoff(options.now ?? new Date());

  return prisma.$transaction(
    async (tx) => {
      const tenants: TenantInvariantReport[] = [];
      for (const tenantId of tenantIds) {
        const open = await tx.$queryRaw<OpenWrappedRow[]>(Prisma.sql`
          SELECT w."id", w."type"::text AS "subtype",
                 cr."status"::text AS "requestStatus"
          FROM "human_decisions" w
          LEFT JOIN "chatbot_requests" cr ON cr."humanDecisionId" = w."id"
          WHERE w."tenantId" = ${tenantId} AND w."status" = 'PENDING'
            AND w."source" = ${RESTOCK_SOURCE}
          UNION ALL
          SELECT w."id", 'DELIVERY_ZONE', cr."status"::text
          FROM "delivery_zone_requests" w
          LEFT JOIN "chatbot_requests" cr ON cr."deliveryZoneRequestId" = w."id"
          WHERE w."tenantId" = ${tenantId} AND w."status" = 'PENDING'
            AND w."validationId" IS NOT NULL
          UNION ALL
          SELECT w."id", 'TRANSFER_RECEIPT', cr."status"::text
          FROM "receipt_evidences" w
          LEFT JOIN "chatbot_requests" cr ON cr."receiptEvidenceId" = w."id"
          WHERE w."tenantId" = ${tenantId} AND w."status" = 'PENDING'`);
        const resolvedOpen = await tx.$queryRaw<
          { id: string; subtype: string }[]
        >(
          Prisma.sql`
          SELECT w."id", w."type"::text AS "subtype"
          FROM "chatbot_requests" cr
          JOIN "human_decisions" w ON w."id" = cr."humanDecisionId"
          WHERE cr."tenantId" = ${tenantId}
            AND cr."status" IN ('NEW', 'IN_PROGRESS') AND w."status" = 'RESOLVED'
          UNION ALL
          SELECT w."id", 'DELIVERY_ZONE'
          FROM "chatbot_requests" cr
          JOIN "delivery_zone_requests" w ON w."id" = cr."deliveryZoneRequestId"
          WHERE cr."tenantId" = ${tenantId}
            AND cr."status" IN ('NEW', 'IN_PROGRESS') AND w."status" = 'RESOLVED'
          UNION ALL
          SELECT w."id", 'TRANSFER_RECEIPT'
          FROM "chatbot_requests" cr
          JOIN "receipt_evidences" w ON w."id" = cr."receiptEvidenceId"
          WHERE cr."tenantId" = ${tenantId}
            AND cr."status" IN ('NEW', 'IN_PROGRESS') AND w."status" <> 'PENDING'`,
        );
        const unwrappedResolved: { id: string; subtype: string }[] = [];
        for (const family of FAMILIES) {
          unwrappedResolved.push(
            ...(await tx.$queryRaw<
              { id: string; subtype: string }[]
            >(Prisma.sql`
              SELECT w."id", ${family.subtype} AS "subtype"
              FROM ${family.table}
              WHERE w."tenantId" = ${tenantId} AND ${family.qualifies(cutoff)}
                AND w."status"::text <> 'PENDING'
                AND NOT EXISTS (SELECT 1 FROM "chatbot_requests" cr
                                WHERE ${family.wrappedRef} = w."id")
              ORDER BY w."id"`)),
          );
        }
        const [{ openRequests }] = await tx.$queryRaw<
          { openRequests: number }[]
        >(
          Prisma.sql`
          SELECT count(*)::int AS "openRequests" FROM "chatbot_requests"
          WHERE "tenantId" = ${tenantId} AND "status" IN ('NEW', 'IN_PROGRESS')
            AND ("humanDecisionId" IS NOT NULL
              OR "deliveryZoneRequestId" IS NOT NULL
              OR "receiptEvidenceId" IS NOT NULL)`,
        );
        const groups = await tx.$queryRaw<{ customerKey: string }[]>(Prisma.sql`
          SELECT coalesce(g."customerKey", r."customerKey") AS "customerKey"
          FROM (SELECT "customerKey", "openCount" FROM "chatbot_customer_groups"
                WHERE "tenantId" = ${tenantId}) g
          FULL JOIN (SELECT "customerKey", count(*)::int AS "n"
                     FROM "chatbot_requests"
                     WHERE "tenantId" = ${tenantId}
                       AND "status" IN ('NEW', 'IN_PROGRESS')
                     GROUP BY "customerKey") r
            ON r."customerKey" = g."customerKey"
          WHERE g."openCount" IS DISTINCT FROM r."n"
          ORDER BY 1`);

        const mismatches: Mismatch[] = [];
        for (const row of open) {
          if (row.requestStatus === null) {
            mismatches.push({
              kind: 'MISSING_REQUEST',
              subtype: row.subtype,
              id: row.id,
            });
          } else if (row.requestStatus === 'RESOLVED') {
            mismatches.push({
              kind: 'STATE_DISAGREES',
              subtype: row.subtype,
              id: row.id,
            });
          }
        }
        for (const row of unwrappedResolved) {
          mismatches.push({
            kind: 'RESOLVED_UNWRAPPED',
            subtype: row.subtype,
            id: row.id,
          });
        }
        for (const row of resolvedOpen) {
          mismatches.push({
            kind: 'STATE_DISAGREES',
            subtype: row.subtype,
            id: row.id,
          });
        }
        for (const row of groups) {
          mismatches.push({
            kind: 'GROUP_MISMATCH',
            subtype: null,
            id: maskCustomerKey(row.customerKey),
          });
        }
        tenants.push({
          tenantId,
          openWrapped: open.length,
          openRequests,
          mismatches,
        });
      }
      return { tenants };
    },
    { isolationLevel: 'RepeatableRead', timeout: 60_000, maxWait: 10_000 },
  );
}
