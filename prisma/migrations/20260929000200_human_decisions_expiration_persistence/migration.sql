-- human-decisions-expiration / HD-EXP-01 — persistence additions for the
-- EXPIRATION decision type on the reused `human_decisions` table.
--
-- Depends on 20260929000100 (the new enum members are already committed in an
-- earlier migration transaction). Additive: five new nullable columns, no new
-- table/index/FK and no backfill. Existing RESTOCK rows keep every previously
-- valid value — the new columns default to NULL and the RESTOCK snapshot branch
-- holds — so no historical row changes meaning.
--
-- Stored snapshot only: EXPIRATION rows keep a sanitized projection of the
-- decider's input. There is deliberately no catalog reference (no FK to
-- products/variants); nothing here is a catalog write.
--
-- Three explicit transactions: stage columns + NOT VALID checks, COMMIT to
-- release ACCESS EXCLUSIVE before validation, then COMMIT validation before
-- the short final swap. Old stable checks remain live throughout validation.
-- A later failure leaves earlier phases committed and Prisma marks this file
-- failed: inspect partial state and reconcile manually before any retry.
-- This lock profile is source-checked, not a runtime no-rewrite guarantee.
--
-- Approved design (read-only cross-repo source):
--   houndfe-chatbot-human-decisions/docs/human-decisions-contract-v1.md
--
-- Rollback (manual; inspect committed phases and reverse completed swaps first):
--   ALTER TABLE "human_decisions" DROP CONSTRAINT "human_decisions_snapshot_state";
--   ALTER TABLE "human_decisions" DROP CONSTRAINT "human_decisions_resolution_state_v2";
--   ALTER TABLE "human_decisions" DROP CONSTRAINT "human_decisions_application_outcome_state_v2";
--     -- v1 bodies live in 20260925000100_human_decisions_restock/migration.sql.
--   ALTER TABLE "human_decisions" DROP COLUMN "expirationText";
--   ALTER TABLE "human_decisions" DROP COLUMN "productUnit";
--   ALTER TABLE "human_decisions" DROP COLUMN "variantName";
--   ALTER TABLE "human_decisions" DROP COLUMN "variantOption";
--   ALTER TABLE "human_decisions" DROP COLUMN "variantValue";
--   -- then roll back 20260929000100's enum members (see that file).
BEGIN;

-- AlterTable
-- EXPIRATION snapshot projection. `unit` on the wire maps to `productUnit`.
ALTER TABLE "human_decisions" ADD COLUMN "productUnit" TEXT;

-- AlterTable
ALTER TABLE "human_decisions" ADD COLUMN "variantName" TEXT;

-- AlterTable
ALTER TABLE "human_decisions" ADD COLUMN "variantOption" TEXT;

-- AlterTable
ALTER TABLE "human_decisions" ADD COLUMN "variantValue" TEXT;

-- AlterTable
-- EXPIRATION resolution text; NULL for RESTOCK and for REPORT_EXPIRATION_UNAVAILABLE.
ALTER TABLE "human_decisions" ADD COLUMN "expirationText" TEXT;

-- CheckConstraint
-- Type-aware snapshot shape. An unsupported `type` matches neither branch and
-- therefore fails closed. RESTOCK keeps the four new columns NULL (immutable
-- RESTOCK snapshot untouched). EXPIRATION requires `productUnit` and forbids
-- every RESTOCK-only snapshot column; the variant is either fully absent (all
-- four NULL) or identified, in which case name/option/value stay nullable.
ALTER TABLE "human_decisions"
  ADD CONSTRAINT "human_decisions_snapshot_state"
    CHECK (
      (
        "type" = 'RESTOCK'
        AND "productUnit" IS NULL
        AND "variantName" IS NULL
        AND "variantOption" IS NULL
        AND "variantValue" IS NULL
      )
      OR (
        "type" = 'EXPIRATION'
        AND "productUnit" IS NOT NULL
        AND "sku" IS NULL
        AND "requestedQuantity" IS NULL
        AND "observedStockAtRequest" IS NULL
        AND "stockObservedAt" IS NULL
        AND "supersedesDecisionId" IS NULL
        AND (
          (
            "variantId" IS NULL
            AND "variantName" IS NULL
            AND "variantOption" IS NULL
            AND "variantValue" IS NULL
          )
          OR "variantId" IS NOT NULL
        )
      )
    ) NOT VALID;

-- CheckConstraint (validated in phase 2, swapped in phase 3)
-- Replaces "human_decisions_resolution_state".
-- Type-aware resolution coupling. The PENDING v1 shape and the RESOLVED v2 audit
-- requirements are unchanged, with one added NULL: `expirationText` must be NULL
-- while PENDING. Each type then owns its own action pair:
--   RESTOCK 1..365 days OR unavailable, `expirationText` always NULL.
--   EXPIRATION text OR unavailable, `restockDays` always NULL.
-- `resolvedById` stays excluded (its FK is ON DELETE SET NULL); the immutable
-- `resolvedByActorId`/`resolvedByDisplayName` snapshots carry durable identity.
ALTER TABLE "human_decisions"
  ADD CONSTRAINT "human_decisions_resolution_state_v2"
    CHECK (
      (
        "status" = 'PENDING'
        AND "version" = 1
        AND "resolutionAction" IS NULL
        AND "restockDays" IS NULL
        AND "expirationText" IS NULL
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
          (
            "type" = 'RESTOCK'
            AND (
              ("resolutionAction" = 'PROVIDE_RESTOCK_ESTIMATE' AND "restockDays" IS NOT NULL AND "expirationText" IS NULL)
              OR ("resolutionAction" = 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE' AND "restockDays" IS NULL AND "expirationText" IS NULL)
            )
          )
          OR (
            "type" = 'EXPIRATION'
            AND (
              ("resolutionAction" = 'PROVIDE_EXPIRATION_TEXT' AND "expirationText" IS NOT NULL AND "restockDays" IS NULL)
              OR ("resolutionAction" = 'REPORT_EXPIRATION_UNAVAILABLE' AND "expirationText" IS NULL AND "restockDays" IS NULL)
            )
          )
        )
      )
    ) NOT VALID;

-- CheckConstraint (validated in phase 2, swapped in phase 3)
-- Replaces "human_decisions_application_outcome_state".
-- Same four terminal outcomes, same terminal CAS shape and evidence coupling as
-- the v1 body; the single change is a shared per-type deadline. The deadline is
-- a CASE over `type`: RESTOCK keeps exactly 1 hour, EXPIRATION gets 24 hours.
-- Every attempted send stays in the half-open window [resolvedAt, deadline);
-- on-time acceptance is strictly before the deadline and LATE is at/after it.
-- The explicit `"type" IN (...)` guard keeps the CASE two-valued: without it an
-- unsupported type would make the CASE NULL and the comparison UNKNOWN, which a
-- CHECK silently accepts. `resolvedAt`/`applicationAttemptedAt`/
-- `providerAcceptedObservedAt` are asserted non-null before every comparison for
-- the same reason. `ackReceivedAt` keeps presence-only semantics — no deadline
-- is imposed on it beyond the existing NOT NULL requirement.
ALTER TABLE "human_decisions"
  ADD CONSTRAINT "human_decisions_application_outcome_state_v2"
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
        AND "type" IN ('RESTOCK', 'EXPIRATION')
        AND (
          (
            "applicationOutcome" = 'PROVIDER_ACCEPTED'
            AND "providerMessageId" IS NOT NULL
            AND "providerAcceptedObservedAt" IS NOT NULL
            AND "providerAcceptedObservedAt" >= "resolvedAt"
            AND "providerAcceptedObservedAt" < "resolvedAt" + (CASE "type" WHEN 'RESTOCK' THEN INTERVAL '1 hour' WHEN 'EXPIRATION' THEN INTERVAL '24 hours' END)
            AND "applicationAttemptedAt" IS NOT NULL
            AND "applicationAttemptedAt" >= "resolvedAt"
            AND "applicationAttemptedAt" < "resolvedAt" + (CASE "type" WHEN 'RESTOCK' THEN INTERVAL '1 hour' WHEN 'EXPIRATION' THEN INTERVAL '24 hours' END)
          )
          OR (
            "applicationOutcome" = 'PROVIDER_ACCEPTED_LATE'
            AND "providerMessageId" IS NOT NULL
            AND "providerAcceptedObservedAt" IS NOT NULL
            AND "providerAcceptedObservedAt" >= "resolvedAt" + (CASE "type" WHEN 'RESTOCK' THEN INTERVAL '1 hour' WHEN 'EXPIRATION' THEN INTERVAL '24 hours' END)
            AND "applicationAttemptedAt" IS NOT NULL
            AND "applicationAttemptedAt" >= "resolvedAt"
            AND "applicationAttemptedAt" < "resolvedAt" + (CASE "type" WHEN 'RESTOCK' THEN INTERVAL '1 hour' WHEN 'EXPIRATION' THEN INTERVAL '24 hours' END)
          )
          OR (
            "applicationOutcome" = 'DELIVERY_UNKNOWN'
            AND "providerAcceptedObservedAt" IS NULL
            AND "applicationAttemptedAt" IS NOT NULL
            AND "applicationAttemptedAt" >= "resolvedAt"
            AND "applicationAttemptedAt" < "resolvedAt" + (CASE "type" WHEN 'RESTOCK' THEN INTERVAL '1 hour' WHEN 'EXPIRATION' THEN INTERVAL '24 hours' END)
          )
          OR (
            "applicationOutcome" = 'STALE'
            AND "applicationAttemptedAt" IS NULL
            AND "providerMessageId" IS NULL
            AND "providerAcceptedObservedAt" IS NULL
          )
        )
      )
    ) NOT VALID;
COMMIT;

BEGIN;
ALTER TABLE "human_decisions" VALIDATE CONSTRAINT "human_decisions_snapshot_state";
ALTER TABLE "human_decisions" VALIDATE CONSTRAINT "human_decisions_resolution_state_v2";
ALTER TABLE "human_decisions" VALIDATE CONSTRAINT "human_decisions_application_outcome_state_v2";
COMMIT;

BEGIN;
ALTER TABLE "human_decisions" DROP CONSTRAINT "human_decisions_resolution_state";
ALTER TABLE "human_decisions" DROP CONSTRAINT "human_decisions_application_outcome_state";
ALTER TABLE "human_decisions" RENAME CONSTRAINT "human_decisions_resolution_state_v2" TO "human_decisions_resolution_state";
ALTER TABLE "human_decisions" RENAME CONSTRAINT "human_decisions_application_outcome_state_v2" TO "human_decisions_application_outcome_state";
COMMIT;
