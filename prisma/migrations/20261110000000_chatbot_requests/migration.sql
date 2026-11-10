-- human-intervention / unit 2 (contract §2.1, §6.2, §10.1): common chatbot
-- request inbox, its append-only audit, the denormalized customer groups and
-- the per-tenant folio counter. Additive only: four new tables; existing
-- tables are only referenced by FKs.
--
-- Locks: every CREATE TABLE/INDEX targets an empty new table. Each FK takes a
-- SHARE ROW EXCLUSIVE lock on the referenced table (tenants, customers,
-- human_decisions, delivery_zone_requests, receipt_evidences) until the
-- migration commits; validation scans the empty new table, so the lock is held
-- for milliseconds, but it waits behind (and queues writers behind) any open
-- transaction on those tables. No referenced table gains a column or index.
--
-- Lock safety: `SET LOCAL lock_timeout` bounds every lock wait to 5 s. Prisma
-- runs this file as one transaction, so on timeout nothing is applied.
-- Deploy note: deploy at low traffic. If it fails on lock timeout, run
--   prisma migrate resolve --rolled-back 20261110000000_chatbot_requests
-- and redeploy.
--
-- Retention (D4, §6.2): triggers at the end keep chatbot_requests forever
-- (direct DELETE rejected) and make chatbot_request_events append-only
-- (UPDATE and direct DELETE rejected). Only a tenant deletion cascades.

SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "ChatbotRequestKind" AS ENUM ('DECISION', 'CLARIFICATION', 'CONVERSATION');

-- CreateEnum
CREATE TYPE "ChatbotRequestSubtype" AS ENUM ('RESTOCK', 'EXPIRATION', 'DELIVERY_ZONE', 'TRANSFER_RECEIPT', 'TALK_TO_HUMAN', 'COMPLAINT', 'UNKNOWN_QUESTION', 'DISCOUNT');

-- CreateEnum
CREATE TYPE "ChatbotRequestStatus" AS ENUM ('NEW', 'IN_PROGRESS', 'RESOLVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ChatbotRequestCancelReason" AS ENUM ('CUSTOMER_WITHDREW', 'SUPERSEDED', 'AUTO_RESOLVED', 'STAFF');

-- CreateEnum
CREATE TYPE "ChatbotRequestStaffCancelReason" AS ENUM ('DUPLICATE', 'NOT_ACTIONABLE', 'CUSTOMER_UNREACHABLE', 'OTHER');

-- CreateEnum
CREATE TYPE "ChatbotRequestEventType" AS ENUM ('CREATED', 'MERGED', 'CLAIMED', 'RELEASED', 'AUTO_RELEASED', 'REASSIGNED', 'RESOLVED', 'REPLIED', 'TEMPLATE_SENT', 'FINISHED', 'CANCELLED', 'RESCHEDULED', 'CUSTOMER_LINKED', 'SLA_MILESTONE', 'DELIVERY_OUTCOME');

-- CreateEnum
CREATE TYPE "ChatbotRequestActorKind" AS ENUM ('USER', 'SERVICE', 'SYSTEM');

-- CreateTable
CREATE TABLE "chatbot_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "folio" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "kind" "ChatbotRequestKind" NOT NULL,
    "subtype" "ChatbotRequestSubtype" NOT NULL,
    "status" "ChatbotRequestStatus" NOT NULL DEFAULT 'NEW',
    "customerId" TEXT,
    "phoneCountryCode" TEXT,
    "phone" TEXT,
    "customerKey" TEXT NOT NULL,
    "ambiguousCustomer" BOOLEAN NOT NULL DEFAULT false,
    "conversationRef" TEXT,
    "assigneeUserId" TEXT,
    "assigneeDisplayName" TEXT,
    "claimedAt" TIMESTAMP(3),
    "claimDeadlineAt" TIMESTAMP(3),
    "resolveDeadlineAt" TIMESTAMP(3),
    "overdueAt" TIMESTAMP(3),
    "slaPolicyVersion" INTEGER,
    "nextSlaCheckAt" TIMESTAMP(3),
    "lastCustomerMessageAt" TIMESTAMP(3),
    "whatsappWindowClosesAt" TIMESTAMP(3),
    "scheduledFor" TIMESTAMP(3),
    "requiresTemplateAtStart" BOOLEAN NOT NULL DEFAULT false,
    "needsReschedule" BOOLEAN NOT NULL DEFAULT false,
    "summary" VARCHAR(140) NOT NULL,
    "needs" VARCHAR(1000),
    "context" JSONB,
    "dedupKey" TEXT,
    "humanDecisionId" TEXT,
    "deliveryZoneRequestId" TEXT,
    "receiptEvidenceId" TEXT,
    "resolution" JSONB,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByActorId" TEXT,
    "resolvedByDisplayName" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" "ChatbotRequestCancelReason",
    "staffCancelReason" "ChatbotRequestStaffCancelReason",
    "closedAt" TIMESTAMP(3),
    "source" TEXT NOT NULL,
    "sourceRequestId" TEXT NOT NULL,
    "canonicalRequestHash" TEXT,
    "submittedCredentialId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chatbot_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chatbot_request_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "type" "ChatbotRequestEventType" NOT NULL,
    "actorKind" "ChatbotRequestActorKind" NOT NULL,
    "actorId" TEXT,
    "actorDisplayName" TEXT,
    "fromStatus" "ChatbotRequestStatus",
    "toStatus" "ChatbotRequestStatus",
    "version" INTEGER NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chatbot_request_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chatbot_customer_groups" (
    "tenantId" TEXT NOT NULL,
    "customerKey" TEXT NOT NULL,
    "mostUrgentAt" TIMESTAMP(3),
    "openCount" INTEGER NOT NULL,
    "hasOverdue" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chatbot_customer_groups_pkey" PRIMARY KEY ("tenantId","customerKey")
);

-- CreateTable
CREATE TABLE "chatbot_request_folio_counters" (
    "tenantId" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chatbot_request_folio_counters_pkey" PRIMARY KEY ("tenantId")
);

-- CreateIndex
CREATE UNIQUE INDEX "chatbot_requests_humanDecisionId_key" ON "chatbot_requests"("humanDecisionId");

-- CreateIndex
CREATE UNIQUE INDEX "chatbot_requests_deliveryZoneRequestId_key" ON "chatbot_requests"("deliveryZoneRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "chatbot_requests_receiptEvidenceId_key" ON "chatbot_requests"("receiptEvidenceId");

-- CreateIndex
CREATE INDEX "chatbot_requests_tenantId_customerKey_status_idx" ON "chatbot_requests"("tenantId", "customerKey", "status");

-- CreateIndex
CREATE INDEX "chatbot_requests_customerId_idx" ON "chatbot_requests"("customerId");

-- CreateIndex
CREATE INDEX "chatbot_requests_tenantId_subtype_closedAt_idx" ON "chatbot_requests"("tenantId", "subtype", "closedAt" DESC);

-- CreateIndex
CREATE INDEX "chatbot_requests_tenantId_resolvedByActorId_closedAt_idx" ON "chatbot_requests"("tenantId", "resolvedByActorId", "closedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "chatbot_requests_tenantId_id_key" ON "chatbot_requests"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "chatbot_requests_tenantId_folio_key" ON "chatbot_requests"("tenantId", "folio");

-- CreateIndex
CREATE UNIQUE INDEX "chatbot_requests_tenantId_source_sourceRequestId_key" ON "chatbot_requests"("tenantId", "source", "sourceRequestId");

-- CreateIndex
CREATE INDEX "chatbot_request_events_tenantId_requestId_createdAt_id_idx" ON "chatbot_request_events"("tenantId", "requestId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "chatbot_customer_groups_tenantId_mostUrgentAt_customerKey_idx" ON "chatbot_customer_groups"("tenantId", "mostUrgentAt", "customerKey");

-- AddForeignKey
ALTER TABLE "chatbot_requests" ADD CONSTRAINT "chatbot_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chatbot_requests" ADD CONSTRAINT "chatbot_requests_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chatbot_requests" ADD CONSTRAINT "chatbot_requests_humanDecisionId_fkey" FOREIGN KEY ("humanDecisionId") REFERENCES "human_decisions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "chatbot_requests" ADD CONSTRAINT "chatbot_requests_deliveryZoneRequestId_fkey" FOREIGN KEY ("deliveryZoneRequestId") REFERENCES "delivery_zone_requests"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "chatbot_requests" ADD CONSTRAINT "chatbot_requests_receiptEvidenceId_fkey" FOREIGN KEY ("receiptEvidenceId") REFERENCES "receipt_evidences"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "chatbot_request_events" ADD CONSTRAINT "chatbot_request_events_tenantId_requestId_fkey" FOREIGN KEY ("tenantId", "requestId") REFERENCES "chatbot_requests"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chatbot_customer_groups" ADD CONSTRAINT "chatbot_customer_groups_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chatbot_request_folio_counters" ADD CONSTRAINT "chatbot_request_folio_counters_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Partial indexes (Prisma's DSL cannot express them).
-- SLA sweep: `WHERE nextSlaCheckAt <= now() … FOR UPDATE SKIP LOCKED LIMIT 100`.
-- `<=` implies NOT NULL, so the planner uses this index without the query
-- repeating the predicate; sla_sweep_open_chk keeps it open-only.
CREATE INDEX "chatbot_requests_sla_sweep_idx" ON "chatbot_requests"("nextSlaCheckAt") WHERE "nextSlaCheckAt" IS NOT NULL;
-- History (§3.8): closed rows newest first, cursor (closedAt, id).
CREATE INDEX "chatbot_requests_history_idx" ON "chatbot_requests"("tenantId", "closedAt" DESC, "id" DESC) WHERE "status" IN ('RESOLVED', 'CANCELLED');
-- Counters (§3.8): new / inProgress.
CREATE INDEX "chatbot_requests_open_status_idx" ON "chatbot_requests"("tenantId", "status") WHERE "status" IN ('NEW', 'IN_PROGRESS');
-- Counter: mine.
CREATE INDEX "chatbot_requests_open_assignee_idx" ON "chatbot_requests"("tenantId", "assigneeUserId") WHERE "status" = 'IN_PROGRESS';
-- Counter: overdue.
CREATE INDEX "chatbot_requests_open_overdue_idx" ON "chatbot_requests"("tenantId") WHERE "status" IN ('NEW', 'IN_PROGRESS') AND "overdueAt" IS NOT NULL;
-- Counter: windowClosingSoon (`whatsappWindowClosesAt` within the warning window).
CREATE INDEX "chatbot_requests_open_window_idx" ON "chatbot_requests"("tenantId", "whatsappWindowClosesAt") WHERE "status" IN ('NEW', 'IN_PROGRESS') AND "whatsappWindowClosesAt" IS NOT NULL;
-- Counters: scheduled / needsReschedule.
CREATE INDEX "chatbot_requests_open_scheduled_idx" ON "chatbot_requests"("tenantId", "scheduledFor") WHERE "status" IN ('NEW', 'IN_PROGRESS') AND "scheduledFor" IS NOT NULL;
CREATE INDEX "chatbot_requests_open_needs_reschedule_idx" ON "chatbot_requests"("tenantId") WHERE "status" IN ('NEW', 'IN_PROGRESS') AND "needsReschedule";
-- §3.5: one open request per (customer, dedupKey); the intake merges into it.
CREATE UNIQUE INDEX "chatbot_requests_open_dedup_key" ON "chatbot_requests"("tenantId", "customerKey", "dedupKey") WHERE "status" IN ('NEW', 'IN_PROGRESS') AND "dedupKey" IS NOT NULL;

-- State consistency.
ALTER TABLE "chatbot_requests"
  ADD CONSTRAINT "chatbot_requests_kind_subtype_chk" CHECK (
    ("kind" = 'DECISION' AND "subtype" IN ('RESTOCK', 'EXPIRATION', 'DELIVERY_ZONE', 'TRANSFER_RECEIPT', 'DISCOUNT'))
    OR ("kind" = 'CLARIFICATION' AND "subtype" = 'UNKNOWN_QUESTION')
    OR ("kind" = 'CONVERSATION' AND "subtype" IN ('TALK_TO_HUMAN', 'COMPLAINT'))
  ),
  -- Exactly the wrapped link the subtype requires, hence at most one.
  ADD CONSTRAINT "chatbot_requests_wrapped_link_chk" CHECK (
    ("humanDecisionId" IS NOT NULL) = ("subtype" IN ('RESTOCK', 'EXPIRATION'))
    AND ("deliveryZoneRequestId" IS NOT NULL) = ("subtype" = 'DELIVERY_ZONE')
    AND ("receiptEvidenceId" IS NOT NULL) = ("subtype" = 'TRANSFER_RECEIPT')
  ),
  ADD CONSTRAINT "chatbot_requests_positive_chk" CHECK ("version" >= 1 AND "folio" >= 1 AND length("customerKey") > 0),
  ADD CONSTRAINT "chatbot_requests_phone_pair_chk" CHECK (("phoneCountryCode" IS NULL) = ("phone" IS NULL)),
  -- An ambiguous key never links a customer (staff links it by hand, R1).
  ADD CONSTRAINT "chatbot_requests_ambiguous_customer_chk" CHECK (NOT "ambiguousCustomer" OR "customerId" IS NULL),
  -- Every path sets or clears the assignee and claimedAt together.
  ADD CONSTRAINT "chatbot_requests_assignee_claimed_at_chk" CHECK (("assigneeUserId" IS NULL) = ("claimedAt" IS NULL)),
  -- IN_PROGRESS has an assignee; NEW has none; closed rows keep the last one.
  ADD CONSTRAINT "chatbot_requests_assignee_state_chk" CHECK (
    ("assigneeUserId" IS NULL) = ("assigneeDisplayName" IS NULL)
    AND (
      ("status" = 'IN_PROGRESS' AND "assigneeUserId" IS NOT NULL AND "claimedAt" IS NOT NULL)
      OR ("status" = 'NEW' AND "assigneeUserId" IS NULL AND "claimedAt" IS NULL)
      OR "status" IN ('RESOLVED', 'CANCELLED')
    )
  ),
  ADD CONSTRAINT "chatbot_requests_resolved_state_chk" CHECK (
    ("status" = 'RESOLVED') = ("resolvedAt" IS NOT NULL)
    AND ("resolvedByActorId" IS NULL) = ("resolvedByDisplayName" IS NULL)
    AND ("resolvedByActorId" IS NULL OR "resolvedAt" IS NOT NULL)
  ),
  ADD CONSTRAINT "chatbot_requests_cancelled_state_chk" CHECK (
    ("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL)
    AND ("cancelledAt" IS NULL) = ("cancelReason" IS NULL)
  ),
  ADD CONSTRAINT "chatbot_requests_staff_cancel_reason_chk" CHECK (
    COALESCE("cancelReason" = 'STAFF', false) = ("staffCancelReason" IS NOT NULL)
  ),
  ADD CONSTRAINT "chatbot_requests_closed_at_chk" CHECK (
    "closedAt" IS NOT DISTINCT FROM COALESCE("resolvedAt", "cancelledAt")
  ),
  ADD CONSTRAINT "chatbot_requests_sla_sweep_open_chk" CHECK (
    "nextSlaCheckAt" IS NULL OR "status" IN ('NEW', 'IN_PROGRESS')
  ),
  -- The window is normally message + 24 h, but whatever Meta reports is
  -- stored (§4.5); only both-or-neither is enforced.
  ADD CONSTRAINT "chatbot_requests_whatsapp_window_chk" CHECK (
    ("whatsappWindowClosesAt" IS NULL) = ("lastCustomerMessageAt" IS NULL)
  ),
  -- Scheduling exists only on conversations; its flags need a scheduledFor.
  ADD CONSTRAINT "chatbot_requests_scheduling_chk" CHECK (
    ("scheduledFor" IS NULL OR "kind" = 'CONVERSATION')
    AND ("scheduledFor" IS NOT NULL OR (NOT "requiresTemplateAtStart" AND NOT "needsReschedule"))
  );

ALTER TABLE "chatbot_request_events"
  ADD CONSTRAINT "chatbot_request_events_actor_chk" CHECK (
    ("actorKind" = 'SYSTEM') = ("actorId" IS NULL)
    AND ("actorKind" <> 'SYSTEM' OR "actorDisplayName" IS NULL)
    AND ("actorKind" <> 'USER' OR "actorDisplayName" IS NOT NULL)
    AND "version" >= 1
  );

-- A group row exists only while its customer has open requests.
ALTER TABLE "chatbot_customer_groups"
  ADD CONSTRAINT "chatbot_customer_groups_open_count_chk" CHECK ("openCount" > 0);

ALTER TABLE "chatbot_request_folio_counters"
  ADD CONSTRAINT "chatbot_request_folio_counters_last_number_chk" CHECK ("lastNumber" >= 0);

-- §6.2: chatbot_request_events is append-only. UPDATE is always rejected.
-- DELETE is allowed only when it runs inside the FK cascade from
-- chatbot_requests (itself cascaded from tenants): the RI cascade trigger is
-- depth 1, so this trigger sees pg_trigger_depth() > 1 there and exactly 1
-- for a direct DELETE. A tenant deletion still removes its audit; a direct
-- DELETE fails.
-- TRUNCATE fires no row trigger, so the test reset (TRUNCATE tenants CASCADE)
-- keeps working.
CREATE FUNCTION "chatbot_request_events_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'chatbot_request_events is append-only (% rejected)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "chatbot_request_events_append_only"
  BEFORE UPDATE OR DELETE ON "chatbot_request_events"
  FOR EACH ROW EXECUTE FUNCTION "chatbot_request_events_append_only"();

-- D4: requests are kept forever. A direct DELETE (depth 1) is rejected; the
-- tenant cascade runs inside the RI trigger, so this trigger sees depth > 1
-- there and lets it through. Rejecting the parent also protects its audit.
CREATE FUNCTION "chatbot_requests_keep_forever"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'chatbot_requests rows are kept forever (DELETE rejected)'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "chatbot_requests_keep_forever"
  BEFORE DELETE ON "chatbot_requests"
  FOR EACH ROW EXECUTE FUNCTION "chatbot_requests_keep_forever"();
