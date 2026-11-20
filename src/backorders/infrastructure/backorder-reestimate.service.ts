/**
 * restock-backorder / T4 (contract v1 §8, owner D6): the overdue-ETA
 * re-estimate. Two halves, both exactly-once:
 *
 *  A. REQUEST (`requestForGroup`, driven by the sweep). A WAITING backorder
 *     whose `estimatedAt` passed (etaStage 0) asks staff for a NEW estimate
 *     BEFORE the customer hears anything. There is ONE decision per
 *     (tenant, product, variant) at a time: the overdue backorders of a product
 *     attach to the pending one (`reestimateDecisionId`, etaStage 1); only when
 *     none is pending is a server-side RESTOCK decision created.
 *  B. ANSWER (`applyAnswer`, run by the RESTOCK resolution listener in the SAME
 *     transaction as the staff resolution, and by the sweep as a repair). Every
 *     WAITING backorder attached to the decision (etaStage 1) moves to etaStage
 *     2, its `version` is bumped, it gets the new `estimatedAt` /
 *     `estimatedArrivalDays` (PROVIDE) and its own feed item
 *     `backorder.eta_updated` / `backorder.eta_unavailable`.
 *
 * WHY THE DECISION IS CREATED IN ITS OWN TRANSACTION. `PrismaRestockIntakeRepository
 * .submit` opens its own transaction and refuses to run nested (a unique-race
 * `P2002` aborts the ambient transaction). So the group handler is NOT in a
 * transaction: (1) read the product's re-estimate state in ONE statement,
 * (2) `submit` (own transaction, idempotent), (3) a second transaction attaches
 * the group. A crash between (2) and (3) leaves a pending decision without
 * attached backorders; the next tick finds it (the pending lookup) and attaches.
 *
 * ONE DECISION UNDER CONCURRENT TICKS / REPLICAS. The state read is one SQL
 * statement (one snapshot): `(oldest PENDING re-estimate decision, how many were
 * ever created)`. The new decision's identity (`sourceRequestId`) is a UUID
 * derived from tenant + product + variant + round (`count + 1`), so two ticks
 * that both decide to open the same round compute the SAME identity and
 * `submit` (unique `(tenant, source, sourceRequestId)`, hash-checked) makes the
 * second one a replay. A snapshot that already sees the pending decision
 * attaches instead. A slow tick whose round was meanwhile answered gets a
 * RESOLVED decision back, re-reads and opens the next round (bounded retries).
 *
 * THE ATTACH TRANSACTION (lock order). The decision row `FOR SHARE` FIRST (it
 * must still be PENDING; a staff resolution waits for it, so an attached
 * backorder is always seen by the fan-out; a resolution that won first makes
 * the attach answer `ANSWERED` and `requestForGroup` re-reads the state and
 * opens the next round IN THE SAME CALL, bounded by `MAX_ROUNDS_PER_GROUP`), then the overdue
 * backorders of the group `FOR UPDATE SKIP LOCKED` in queue order
 * (`scheduledAt, id`, like the allocator). Nothing here takes stock; no feed.
 *
 * THE ANSWER (lock order). The listener runs inside the staff resolver's
 * transaction (chatbot request row → decision row → here), which has the
 * default 5 s Prisma transaction timeout. It therefore never WAITS for a
 * backorder row: it locks the `WAITING` attached backorders `FOR UPDATE SKIP
 * LOCKED`, in `scheduledAt, id` order. A row the allocator, a cancel, a
 * checkout or another tick holds is skipped; it stays WAITING with etaStage 1
 * attached to the (now RESOLVED) decision and the sweep's repair phase (5)
 * applies the same answer on its next pass, exactly once (the move etaStage 1
 * → 2 is a guarded update under the row lock, the feed item is unique per
 * version). Never a RESERVED row: it is held by the allocator/cancel path that
 * takes stock first, and an answer for it is not wanted anyway. The feed's
 * advisory lock comes last. A backorder that is RESERVED / CONFIRMED /
 * CANCELLED / EXPIRED at that moment is skipped (no message); one that returns
 * to WAITING later (a lost lot) while still attached is answered by the same
 * repair phase from the already-resolved decision.
 *
 * ONCE ONLY. The answer moves etaStage 1 → 2 under the row lock with a guarded
 * UPDATE; the feed item is exactly-once on top (`chatbot_feed_items_backorder_
 * stage_uq`, keyed on the bumped version). A backorder with etaStage 2 that is
 * overdue again never asks again (T5's staff list flags `etaOverdue`).
 *
 * NO EXPIRY. A RESTOCK decision has no expiry, no cancel and no EXPIRED state
 * (schema comment on `HumanDecisionStatus`; the only writers are the intake, the
 * staff resolve and the bot ACK). If staff never answer, the attached
 * backorders stay WAITING with etaStage 1, the customer is told nothing and
 * the queue order is untouched; they can still be reserved on arrival or
 * cancelled. The decision stays PENDING in the staff list until answered.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  RESTOCK_INTAKE_REPOSITORY,
  RestockIntakeError,
  type IRestockIntakeRepository,
} from '../../human-decisions/domain/restock-intake.repository';
import { RESTOCK_SOURCE } from '../../human-decisions/domain/restock-request-canonicalizer';
import type {
  RestockResolutionListener,
  RestockResolvedEvent,
} from '../../human-decisions/domain/restock-resolution.listener';
import { RestockResolutionRegistry } from '../../human-decisions/infrastructure/restock-resolution.registry';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  ETA_STAGE,
  planEtaResolution,
  planReestimate,
  REESTIMATE_SYSTEM_CREDENTIAL_ID,
  reestimateSourceRequestId,
  type EtaResolution,
} from '../domain/backorder-reestimate';
import {
  enqueueBackorderEtaUnavailable,
  enqueueBackorderEtaUpdated,
} from './backorder-feed-writes';

type TenantClient = ReturnType<TenantPrismaService['getClient']>;

/** One product/variant whose WAITING backorders are overdue. */
export interface OverdueGroup {
  tenantId: string;
  productId: string;
  variantId: string | null;
}

export interface ReestimateRequestResult {
  /** A new decision was created (round opened). */
  created: boolean;
  /** Backorders attached to the pending decision. */
  attached: number;
}

/** A pending decision that was resolved under this tick: retry a few times. */
const MAX_ROUNDS_PER_GROUP = 3;
const PRODUCT_NAME_MAX = 200;

/** A product / SKU text the RESTOCK canonicalizer accepts (never throws on odd catalog data). */
function cleanText(value: string): string {
  // eslint-disable-next-line no-control-regex -- strips C0/C1 controls the canonicalizer refuses
  return value.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ');
}

export function snapshotProductName(name: string): string {
  const collapsed = cleanText(name).replace(/\s+/gu, ' ').trim();
  const clipped = Array.from(collapsed).slice(0, PRODUCT_NAME_MAX).join('');
  return clipped.length > 0 ? clipped : 'Producto';
}

export function snapshotSku(sku: string | null): string | null {
  if (sku === null) return null;
  const clean = cleanText(sku).trim();
  return clean.length > 0 ? clean : null;
}

@Injectable()
export class BackorderReestimateService implements RestockResolutionListener {
  private readonly logger = new Logger(BackorderReestimateService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    @Inject(RESTOCK_INTAKE_REPOSITORY)
    private readonly intake: IRestockIntakeRepository,
    registry: RestockResolutionRegistry,
  ) {
    // No lifecycle hook (the pca-5b boot harness fails closed on unreviewed
    // ones): the registration happens at construction, like the allocator's.
    registry.register(this);
  }

  // ---------------------------------------------------------------- A. request

  /**
   * Opens (or joins) the re-estimate of one product/variant and attaches its
   * overdue backorders. Run it inside `runWithTenant(group.tenantId)` and
   * OUTSIDE any transaction (`submit` refuses to nest).
   */
  async requestForGroup(
    group: OverdueGroup,
    now: Date,
  ): Promise<ReestimateRequestResult> {
    const result: ReestimateRequestResult = { created: false, attached: 0 };
    for (let round = 0; round < MAX_ROUNDS_PER_GROUP; round++) {
      const state = await this.readState(group);
      const plan = planReestimate(state);
      let decisionId: string;
      if (plan.kind === 'attach') {
        decisionId = plan.decisionId;
      } else {
        const opened = await this.openRound(group, plan.round);
        if (opened === 'RETRY') continue;
        decisionId = opened.id;
        result.created = opened.created;
      }
      const attached = await this.attach(group, decisionId, now);
      if (attached === 'ANSWERED') continue;
      result.attached = attached;
      return result;
    }
    return result;
  }

  /** ONE statement = one snapshot: the pending decision and how many exist. */
  private async readState(group: OverdueGroup): Promise<{
    pendingDecisionId: string | null;
    decisionsCreated: number;
  }> {
    const db = this.tenantPrisma.getClient();
    const [row] = await db.$queryRaw<
      Array<{ pendingDecisionId: string | null; decisionsCreated: number }>
    >(Prisma.sql`
      SELECT
        (SELECT d."id" FROM "human_decisions" d
          WHERE d."tenantId" = ${group.tenantId}
            AND d."source" = ${RESTOCK_SOURCE} AND d."type" = 'RESTOCK'
            AND d."submittedCredentialId" = ${REESTIMATE_SYSTEM_CREDENTIAL_ID}
            AND d."productId" = ${group.productId}
            AND d."variantId" IS NOT DISTINCT FROM ${group.variantId}::text
            AND d."status" = 'PENDING'
          ORDER BY d."createdAt", d."id" LIMIT 1) AS "pendingDecisionId",
        (SELECT count(*)::int FROM "human_decisions" d
          WHERE d."tenantId" = ${group.tenantId}
            AND d."source" = ${RESTOCK_SOURCE} AND d."type" = 'RESTOCK'
            AND d."submittedCredentialId" = ${REESTIMATE_SYSTEM_CREDENTIAL_ID}
            AND d."productId" = ${group.productId}
            AND d."variantId" IS NOT DISTINCT FROM ${group.variantId}::text
        ) AS "decisionsCreated"`);
    return row;
  }

  /**
   * `submit` is the only writer of the decision (own transaction). The
   * identity is deterministic, so concurrent openers of the same round get one
   * decision. `RETRY`: the round was already answered (a slow tick) or the
   * catalog snapshot changed under the same identity; the state is re-read.
   */
  private async openRound(
    group: OverdueGroup,
    round: number,
  ): Promise<{ id: string; created: boolean } | 'RETRY'> {
    const db = this.tenantPrisma.getClient();
    const product = await db.product.findFirst({
      where: { id: group.productId, tenantId: group.tenantId },
      select: { name: true, sku: true },
    });
    if (!product) throw new Error('re-estimate: the product does not exist');
    const variant = group.variantId
      ? await db.variant.findFirst({
          where: { id: group.variantId },
          select: { sku: true },
        })
      : null;
    try {
      const outcome = await this.intake.submit(
        {
          sourceRequestId: reestimateSourceRequestId(
            group.tenantId,
            group.productId,
            group.variantId,
            round,
          ),
          productId: group.productId,
          productName: snapshotProductName(product.name),
          variantId: group.variantId,
          sku: snapshotSku(variant?.sku ?? product.sku ?? null),
          // No quantity / stock snapshot: they would change between ticks and
          // make a concurrent replay of the same round an IDEMPOTENCY_CONFLICT.
          requestedQuantity: null,
          observedStockAtRequest: null,
          stockObservedAt: null,
          supersedesDecisionId: null,
          submittedCredentialId: REESTIMATE_SYSTEM_CREDENTIAL_ID,
        },
        { staffOnly: true },
      );
      if (outcome.request.status !== 'PENDING') return 'RETRY';
      return { id: outcome.request.id, created: outcome.status === 'created' };
    } catch (error) {
      if (
        error instanceof RestockIntakeError &&
        (error.code === 'IDEMPOTENCY_CONFLICT' ||
          error.code === 'VERSION_CONFLICT')
      ) {
        return 'RETRY';
      }
      throw error;
    }
  }

  /**
   * Attach every overdue etaStage-0 WAITING backorder of the group to the
   * decision. `ANSWERED`: the decision is no longer pending (a resolution won).
   */
  private attach(
    group: OverdueGroup,
    decisionId: string,
    now: Date,
  ): Promise<number | 'ANSWERED'> {
    return this.tenantPrisma.runInTransaction(async () => {
      const tx = this.tenantPrisma.getClient();
      // The decision first, `FOR SHARE`: a staff resolution waits for us, and
      // one that already won is seen here.
      const [decision] = await tx.$queryRaw<Array<{ status: string }>>(
        Prisma.sql`
          SELECT "status"::text AS "status" FROM "human_decisions"
          WHERE "tenantId" = ${group.tenantId} AND "id" = ${decisionId}
          FOR SHARE`,
      );
      if (!decision || decision.status !== 'PENDING') return 'ANSWERED';

      // Re-checked under the lock: another tick, a cancel or an allocation may
      // have moved a row since the sweep read it.
      const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "backorders"
        WHERE "tenantId" = ${group.tenantId}
          AND "productId" = ${group.productId}
          AND "variantId" IS NOT DISTINCT FROM ${group.variantId}::text
          AND "status" = 'WAITING' AND "etaStage" = ${ETA_STAGE.NONE}
          AND "estimatedAt" < ${now}
        ORDER BY "scheduledAt", "id"
        FOR UPDATE SKIP LOCKED`);
      if (rows.length === 0) return 0;
      const { count } = await tx.backorder.updateMany({
        where: {
          tenantId: group.tenantId,
          id: { in: rows.map((row) => row.id) },
          status: 'WAITING',
          etaStage: ETA_STAGE.NONE,
        },
        data: {
          etaStage: ETA_STAGE.REQUESTED,
          reestimateDecisionId: decisionId,
        },
      });
      return count;
    });
  }

  // ---------------------------------------------------------------- B. answer

  /** The staff resolution, in the resolver's transaction (see the file doc). */
  async onRestockResolved(event: RestockResolvedEvent): Promise<void> {
    const resolution = planEtaResolution({
      action: event.action,
      restockDays: event.restockDays,
      resolvedAt: event.resolvedAt,
    });
    if (!resolution) return;
    await this.applyAnswer(
      this.tenantPrisma.getClient(),
      event.tenantId,
      event.decisionId,
      resolution,
    );
  }

  /**
   * The sweep's repair: the decision is already RESOLVED but a backorder
   * attached to it is still etaStage 1 and WAITING (it was RESERVED when the
   * answer fan-out ran and went back to WAITING, or the listener's savepoint
   * rolled back). Same transaction rules as the listener.
   */
  async applyResolvedDecision(
    tx: TenantClient,
    tenantId: string,
    decisionId: string,
  ): Promise<number> {
    const decision = await tx.humanDecision.findFirst({
      where: { id: decisionId, tenantId, status: 'RESOLVED' },
      select: { resolutionAction: true, restockDays: true, resolvedAt: true },
    });
    if (!decision) return 0;
    const resolution = planEtaResolution({
      action: decision.resolutionAction,
      restockDays: decision.restockDays,
      resolvedAt: decision.resolvedAt,
    });
    if (!resolution) return 0;
    return this.applyAnswer(tx, tenantId, decisionId, resolution);
  }

  /** Returns how many backorders were answered. */
  private async applyAnswer(
    tx: TenantClient,
    tenantId: string,
    decisionId: string,
    resolution: EtaResolution,
  ): Promise<number> {
    // WAITING only, queue order, SKIP LOCKED (see the file doc): the staff
    // resolution never waits on a row someone else holds; a skipped row is
    // still WAITING + etaStage 1 + attached, so the sweep repair finds it.
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "backorders"
      WHERE "tenantId" = ${tenantId} AND "reestimateDecisionId" = ${decisionId}
        AND "status" = 'WAITING' AND "etaStage" = ${ETA_STAGE.REQUESTED}
      ORDER BY "scheduledAt", "id"
      FOR UPDATE SKIP LOCKED`);
    const answered: string[] = [];
    for (const row of rows) {
      const { count } = await tx.backorder.updateMany({
        where: {
          id: row.id,
          tenantId,
          status: 'WAITING',
          etaStage: ETA_STAGE.REQUESTED,
          reestimateDecisionId: decisionId,
        },
        data: {
          etaStage: ETA_STAGE.ANSWERED,
          version: { increment: 1 },
          ...(resolution.kind === 'ESTIMATE'
            ? {
                estimatedAt: resolution.estimatedAt,
                estimatedArrivalDays: resolution.restockDays,
              }
            : {}),
        },
      });
      if (count === 1) answered.push(row.id);
    }
    // Feed items last (the feed's advisory lock is taken by the first insert).
    for (const id of answered) {
      if (resolution.kind === 'ESTIMATE') {
        await enqueueBackorderEtaUpdated(tx, tenantId, id);
      } else {
        await enqueueBackorderEtaUnavailable(tx, tenantId, id);
      }
    }
    if (answered.length > 0) {
      this.logger.log(
        `re-estimate ${decisionId} (tenant ${tenantId}): ${answered.length} backorders answered (${resolution.kind})`,
      );
    }
    return answered.length;
  }
}
