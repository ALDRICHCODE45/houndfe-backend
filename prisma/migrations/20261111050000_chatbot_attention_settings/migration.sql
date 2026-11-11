-- human-intervention / unit 7a (contract §5.4, §5.5): chatbot attention
-- settings per tenant and their audit. Additive only: two NEW tables, no
-- change to an existing table or column, so nothing is rewritten and no
-- existing row is touched or scanned.
--
-- Lock impact: CREATE TABLE / CREATE INDEX target empty new tables (instant).
-- The two foreign keys to "tenants" take a SHARE ROW EXCLUSIVE lock on
-- "tenants" until the migration commits (the new tables are empty, so no
-- validation scan runs); they wait behind, and queue writers behind, open
-- transactions on "tenants". `SET LOCAL lock_timeout` bounds that wait to 5 s
-- and Prisma runs this file as one transaction, so on timeout nothing is
-- applied. No ALTER on "chatbot_requests" (the SLA columns it fills already
-- exist since 20261110000000).
-- Deploy note: deploy at low traffic. If it fails on lock timeout, run
--   prisma migrate resolve --rolled-back 20261111050000_chatbot_attention_settings
-- and redeploy. A tenant without a row uses the defaults (version 0), so no
-- backfill is needed.

SET LOCAL lock_timeout = '5s';

-- CreateTable
CREATE TABLE "chatbot_attention_settings" (
    "tenantId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "timeZone" TEXT NOT NULL,
    "days" JSONB NOT NULL,
    "closedDates" TEXT[],
    "slas" JSONB NOT NULL,
    "windowWarningMinutes" INTEGER NOT NULL,
    "templateName" TEXT,
    "templateCostText" TEXT NOT NULL,
    "enabledSubtypes" "ChatbotRequestSubtype"[],
    "receiptCloseMarginMinutes" INTEGER NOT NULL,
    "schedulingEnabled" BOOLEAN NOT NULL,
    "slotMinutes" INTEGER NOT NULL,
    "slotsOffered" INTEGER NOT NULL,
    "maxScheduledPerSlot" INTEGER NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chatbot_attention_settings_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "chatbot_attention_settings_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorDisplayName" TEXT,
    "fromVersion" INTEGER NOT NULL,
    "toVersion" INTEGER NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chatbot_attention_settings_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: newest audit first per tenant.
CREATE INDEX "chatbot_attention_settings_events_tenantId_createdAt_idx" ON "chatbot_attention_settings_events"("tenantId", "createdAt" DESC);

-- Migration-authoritative CHECKs (Prisma cannot express them): the same bounds
-- the application validates, so a bad write that bypasses it still fails.
ALTER TABLE "chatbot_attention_settings"
  ADD CONSTRAINT "chatbot_attention_settings_version_chk" CHECK ("version" >= 1),
  ADD CONSTRAINT "chatbot_attention_settings_window_chk" CHECK ("windowWarningMinutes" BETWEEN 0 AND 1440),
  ADD CONSTRAINT "chatbot_attention_settings_margin_chk" CHECK ("receiptCloseMarginMinutes" BETWEEN 0 AND 1440),
  ADD CONSTRAINT "chatbot_attention_settings_cost_text_chk" CHECK (char_length("templateCostText") BETWEEN 1 AND 200),
  ADD CONSTRAINT "chatbot_attention_settings_closed_dates_chk" CHECK (cardinality("closedDates") <= 400),
  ADD CONSTRAINT "chatbot_attention_settings_scheduling_chk" CHECK (
    "slotMinutes" BETWEEN 5 AND 240
    AND "slotsOffered" BETWEEN 1 AND 10
    AND "maxScheduledPerSlot" BETWEEN 1 AND 50
  ),
  ADD CONSTRAINT "chatbot_attention_settings_shape_chk" CHECK (
    jsonb_typeof("days") = 'array' AND jsonb_array_length("days") = 7
    AND jsonb_typeof("slas") = 'array' AND jsonb_array_length("slas") = 8
  );

-- AddForeignKey
ALTER TABLE "chatbot_attention_settings" ADD CONSTRAINT "chatbot_attention_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chatbot_attention_settings_events" ADD CONSTRAINT "chatbot_attention_settings_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
