-- human-decisions-restock-v1 / HD-01 — persistence foundation for the RESTOCK
-- human-decision inbox. Schema-only: no route/service/domain code reads or
-- writes here yet (HD-02 onward).
--
-- Approved design (read-only cross-repo source):
--   houndfe-chatbot-human-decisions/docs/human-decisions-contract-v1.md
--
-- Additive and safe for populated databases: one new table plus four new enum
-- types. No existing table is altered, so no historical row changes meaning and
-- there is no backfill. A resolved row is NOT stock mutation, NOT a sale and
-- NOT customer delivery — only the backend decision state is recorded here.
--
-- Identity model:
--   `(tenantId, source, sourceRequestId)` is the idempotent intake identity.
--   The bot supplies a stable UUID that must equal `X-Idempotency-Key`, and the
--   fixed `source` ('houndfe-chatbot') is derived from the guarded route. The
--   rotating service credential is stored audit-only in `submittedCredentialId`
--   and excluded from `canonicalRequestHash`, so the identity survives
--   credential rotation and credential revocation/deletion (no FK: the audit
--   must outlive the credential).
--   `(tenantId, source, supersedesDecisionId)` caps a predecessor at one
--   correlated successor; PostgreSQL unique indexes treat NULLs as distinct, so
--   first requests may repeat NULL. `supersedesDecisionId` deliberately has no
--   FK: same-tenant/same-source plus durable STALE/reconciled eligibility is
--   validated in the intake domain transaction (HD-02).
--
-- Audit/projection additions (corrective continuing review):
--   `submittedCredentialId` records who submitted the intake; the immutable
--   `resolvedByActorId`/`resolvedByDisplayName` snapshots keep the reviewer
--   projection (`{resolvedBy:{id,displayName}}`) readable after the optional
--   `resolvedById` FK is nulled by a User deletion; the ACK `applicationAttemptedAt`
--   and `applicationEvidenceCode` columns are persisted because the evidence
--   hash alone cannot support UNKNOWN/LATE reconciliation. Two CHECK constraints
--   pin the resolution coupling and the outcome/evidence coupling. None of these
--   columns is client authority: intake credential and reviewer identity are
--   derived server-side (ServiceAuthGuard / JWT).
--
-- Rollback (manual; only objects introduced by this migration):
--   DROP TABLE "human_decisions";
--   DROP TYPE "HumanDecisionBotOutcome";
--   DROP TYPE "HumanDecisionResolutionAction";
--   DROP TYPE "HumanDecisionStatus";
--   DROP TYPE "HumanDecisionType";
-- Dropping the table removes its pkey, unique/index constraints, its two CHECK
-- constraints and its FKs, so they need no separate statement above. No existing
-- table is touched, so the rollback has no other object to restore.

-- CreateEnum
CREATE TYPE "HumanDecisionType" AS ENUM ('RESTOCK');

-- CreateEnum
CREATE TYPE "HumanDecisionStatus" AS ENUM ('PENDING', 'RESOLVED');

-- CreateEnum
CREATE TYPE "HumanDecisionResolutionAction" AS ENUM ('PROVIDE_RESTOCK_ESTIMATE', 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE');

-- CreateEnum
-- Terminal bot-reported outcomes only. `PENDING_DELIVERY` is derived from a
-- NULL `applicationOutcome` before the first ACK, so a stored "pending" member
-- cannot exist.
CREATE TYPE "HumanDecisionBotOutcome" AS ENUM ('PROVIDER_ACCEPTED', 'PROVIDER_ACCEPTED_LATE', 'DELIVERY_UNKNOWN', 'STALE');

-- CreateTable
CREATE TABLE "human_decisions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceRequestId" TEXT NOT NULL,
    "type" "HumanDecisionType" NOT NULL DEFAULT 'RESTOCK',
    "canonicalRequestHash" TEXT NOT NULL,
    -- Audit-only intake credential, server-derived from ServiceAuthGuard.
    -- Excluded from the canonical hash; no FK on purpose (revocation must not
    -- erase or block the intake audit).
    "submittedCredentialId" TEXT NOT NULL,
    -- Immutable sanitized snapshot; branch fields are backend-derived.
    "branchId" TEXT NOT NULL,
    "branchName" TEXT,
    "productId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "variantId" TEXT,
    "sku" TEXT,
    "requestedQuantity" INTEGER,
    "observedStockAtRequest" INTEGER,
    "stockObservedAt" TIMESTAMP(3),
    -- Optional correlated successor (same tenant/source, predecessor STALE or
    -- audited; never UNKNOWN).
    "supersedesDecisionId" TEXT,
    -- Human resolution + audit. `version` is the optimistic CAS token.
    "status" "HumanDecisionStatus" NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "resolutionAction" "HumanDecisionResolutionAction",
    "restockDays" INTEGER,
    "resolutionRequestId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    -- Immutable reviewer snapshots, server-derived (JWT/backend actor). Durable
    -- projection source once the FK above is nulled by a User deletion.
    "resolvedByActorId" TEXT,
    "resolvedByDisplayName" TEXT,
    -- Terminal bot application outcome, one per decision (the row is the
    -- guarantee). NULL `applicationOutcome` = PENDING_DELIVERY.
    "applicationOutcome" "HumanDecisionBotOutcome",
    "applicationAttemptId" TEXT,
    "applicationEvidenceHash" TEXT,
    "applicationEvidenceCode" TEXT,
    "providerMessageId" TEXT,
    "providerAcceptedObservedAt" TIMESTAMP(3),
    "applicationAttemptedAt" TIMESTAMP(3),
    "ackReceivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "human_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Idempotent intake identity. A retry with the same tuple returns the same
-- entity; a different canonical payload under the same identity is a 409.
CREATE UNIQUE INDEX "human_decisions_tenantId_source_sourceRequestId_key" ON "human_decisions"("tenantId", "source", "sourceRequestId");

-- CreateIndex
-- One correlated successor per (tenant, source) predecessor. NULLs stay
-- distinct, so unrelated first requests do not collide.
CREATE UNIQUE INDEX "human_decisions_tenantId_source_supersedesDecisionId_key" ON "human_decisions"("tenantId", "source", "supersedesDecisionId");

-- CreateIndex
-- Reviewer queue: `status=PENDING` ordered by stable (createdAt, id).
CREATE INDEX "human_decisions_tenantId_status_createdAt_id_idx" ON "human_decisions"("tenantId", "status", "createdAt", "id");

-- CheckConstraint
-- Zero days, negative days and >365 days are contract violations.
ALTER TABLE "human_decisions"
  ADD CONSTRAINT "human_decisions_restock_days_range"
    CHECK ("restockDays" IS NULL OR ("restockDays" >= 1 AND "restockDays" <= 365));

-- CheckConstraint
-- The resolution is null iff PENDING and non-null iff RESOLVED, and the two
-- actions are discriminated: the estimate carries days, the no-ETA action must
-- NOT. `version` is the CAS token, so it is pinned to 1/2 by the same guard.
-- The immutable reviewer snapshots are pinned by state: both NULL while PENDING,
-- both NOT NULL once RESOLVED.
-- `resolvedById` is intentionally excluded from this CHECK: its FK uses
-- ON DELETE SET NULL, so requiring it non-null here would make a User deletion
-- unsatisfiable; the snapshots above carry the durable reviewer identity.
ALTER TABLE "human_decisions"
  ADD CONSTRAINT "human_decisions_resolution_state"
    CHECK (
      (
        "status" = 'PENDING'
        AND "version" = 1
        AND "resolutionAction" IS NULL
        AND "restockDays" IS NULL
        AND "resolutionRequestId" IS NULL
        AND "resolvedAt" IS NULL
        AND "resolvedByActorId" IS NULL
        AND "resolvedByDisplayName" IS NULL
      )
      OR (
        "status" = 'RESOLVED'
        AND "version" = 2
        AND "resolutionAction" IS NOT NULL
        AND "resolutionRequestId" IS NOT NULL
        AND "resolvedAt" IS NOT NULL
        AND "resolvedByActorId" IS NOT NULL
        AND "resolvedByDisplayName" IS NOT NULL
        AND (
          ("resolutionAction" = 'PROVIDE_RESTOCK_ESTIMATE' AND "restockDays" IS NOT NULL)
          OR ("resolutionAction" = 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE' AND "restockDays" IS NULL)
        )
      )
    );

-- CheckConstraint
-- Outcome/evidence coupling, including the bot-reported temporal window.
-- Three-valued logic note: every branch tests nullable columns with
-- IS NULL / IS NOT NULL, and the terminal branch asserts `"resolvedAt" IS NOT
-- NULL` before any timestamp comparison, so the expression can never evaluate to
-- UNKNOWN and silently pass. The enum comparisons sit inside a branch that
-- already asserts `"applicationOutcome" IS NOT NULL`, so `FALSE AND UNKNOWN`
-- still rejects.
--   * no outcome (derived PENDING_DELIVERY): every outcome/evidence column NULL,
--     including `ackReceivedAt` — a receipt cannot exist without an outcome.
--   * terminal outcome: only after a RESOLVED human decision, with the stable
--     attempt id, the canonical evidence hash and the backend receipt time.
--   * every attempted send (ACCEPTED, ACCEPTED_LATE, DELIVERY_UNKNOWN) has an
--     `applicationAttemptedAt` inside the half-open 1h application window
--     [resolvedAt, resolvedAt + 1 hour).
--   * PROVIDER_ACCEPTED: provider message id plus a bot-observed acceptance
--     timestamp inside that same half-open window.
--   * PROVIDER_ACCEPTED_LATE: provider message id plus a bot-observed acceptance
--     timestamp at/after resolvedAt + 1 hour.
--   * DELIVERY_UNKNOWN: `providerAcceptedObservedAt` must stay NULL (a definite
--     id + timestamp would imply success), while an optional
--     `providerMessageId` may be retained as partial audit evidence.
--   * STALE: no send could have occurred, so attempt and provider evidence are
--     forbidden.
-- All provider timestamps are bot-reported observations, never proof of device
-- delivery or of the backend clock. `applicationEvidenceCode` stays optional
-- (the approved ACK DTO marks it optional) and `applicationEvidenceHash` remains
-- the replay/conflict identity; the HD-05 response DTO is discriminated.
ALTER TABLE "human_decisions"
  ADD CONSTRAINT "human_decisions_application_outcome_state"
    CHECK (
      (
        "applicationOutcome" IS NULL
        AND "applicationAttemptId" IS NULL
        AND "applicationEvidenceHash" IS NULL
        AND "applicationEvidenceCode" IS NULL
        AND "providerMessageId" IS NULL
        AND "providerAcceptedObservedAt" IS NULL
        AND "applicationAttemptedAt" IS NULL
        AND "ackReceivedAt" IS NULL
      )
      OR (
        "applicationOutcome" IS NOT NULL
        AND "status" = 'RESOLVED'
        AND "resolvedAt" IS NOT NULL
        AND "applicationAttemptId" IS NOT NULL
        AND "applicationEvidenceHash" IS NOT NULL
        AND "ackReceivedAt" IS NOT NULL
        AND (
          (
            "applicationOutcome" = 'PROVIDER_ACCEPTED'
            AND "providerMessageId" IS NOT NULL
            AND "providerAcceptedObservedAt" IS NOT NULL
            AND "providerAcceptedObservedAt" >= "resolvedAt"
            AND "providerAcceptedObservedAt" < "resolvedAt" + INTERVAL '1 hour'
            AND "applicationAttemptedAt" IS NOT NULL
            AND "applicationAttemptedAt" >= "resolvedAt"
            AND "applicationAttemptedAt" < "resolvedAt" + INTERVAL '1 hour'
          )
          OR (
            "applicationOutcome" = 'PROVIDER_ACCEPTED_LATE'
            AND "providerMessageId" IS NOT NULL
            AND "providerAcceptedObservedAt" IS NOT NULL
            AND "providerAcceptedObservedAt" >= "resolvedAt" + INTERVAL '1 hour'
            AND "applicationAttemptedAt" IS NOT NULL
            AND "applicationAttemptedAt" >= "resolvedAt"
            AND "applicationAttemptedAt" < "resolvedAt" + INTERVAL '1 hour'
          )
          OR (
            "applicationOutcome" = 'DELIVERY_UNKNOWN'
            AND "providerAcceptedObservedAt" IS NULL
            AND "applicationAttemptedAt" IS NOT NULL
            AND "applicationAttemptedAt" >= "resolvedAt"
            AND "applicationAttemptedAt" < "resolvedAt" + INTERVAL '1 hour'
          )
          OR (
            "applicationOutcome" = 'STALE'
            AND "applicationAttemptedAt" IS NULL
            AND "providerMessageId" IS NULL
            AND "providerAcceptedObservedAt" IS NULL
          )
        )
      )
    );

-- AddForeignKey
ALTER TABLE "human_decisions" ADD CONSTRAINT "human_decisions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Optional reviewer actor; `ON DELETE SET NULL` matches the other optional
-- actor relations (e.g. sale_refund_settlements.settledBy).
ALTER TABLE "human_decisions" ADD CONSTRAINT "human_decisions_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
