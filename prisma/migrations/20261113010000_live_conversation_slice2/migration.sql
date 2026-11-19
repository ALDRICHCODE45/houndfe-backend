-- human-intervention / unit 11, slice 2 (S16 1a and S16 8). Additive: three new
-- columns and two partial-index/CHECK additions. No existing row, column or
-- index changes meaning.
--
-- 1. "chatbot_attention_settings"."startTimeoutSeconds": how long the backend
--    waits for the bot's `session-ack STARTED` before it reverts a claim
--    (S16 1a). Default 120 s (the first slice hard-coded 60 s); the CHECK keeps
--    it between 30 s and 600 s so a typo can neither revert every claim before
--    the bot can answer nor leave a customer muted for hours.
-- 2. "chatbot_attention_settings"."templateLanguageCode": the WhatsApp
--    language code `template.requested` carries (S16 8). Default 'es_MX'; the
--    CHECK accepts the Meta shape `xx` or `xx_YY` (also three-letter languages
--    such as `fil`).
-- 3. "chatbot_live_sessions"."startDeadlineAt": the claim snapshots
--    `startedAt + startTimeoutSeconds` here, so a settings change never moves
--    the deadline of a session that already started and the sweep needs no
--    join. NULL (a session created before this migration) means
--    `startedAt + 120 s`. The partial index serves the sweep's STARTING scan.
--
-- 4. "chatbot_conversations_human_idx": serves the bot's bulk read of the
--    conversations in HUMAN mode (S16 7a) without walking every BOT chat.
-- 5. "conversation_messages_immutable": S16 4. Meta can report error 131047
--    (window closed) AFTER the bot sent a staff message, so the message goes
--    SENT -> DEFERRED (only for STAFF OUT messages, only that one backwards
--    step, every other column unchanged), and the resend's wamid replaces the
--    dead one (only while the message is DEFERRED, only for a forward status).
--    The rest of the function is the body of 20261113000000 unchanged.
--
-- 6. "chatbot_conversations"."windowClosedAt": Meta's verdict that the 24 h
--    window is closed (S16 4, error 131047), the instant it was reported. The
--    window computation treats the window as closed from then until the next
--    customer message; it lives on the chat row so the statuses path never
--    locks the request row (lock order request -> chat -> session -> feed ->
--    messages). Nullable, no default: metadata-only.
--
-- Idempotent on purpose (IF NOT EXISTS / DROP IF EXISTS / CREATE OR REPLACE):
-- the rollback-and-redeploy recipe below, or `migrate resolve --rolled-back`
-- on an environment that already ran an earlier draft of this file, can run it
-- again without error.
--
-- Safe on a populated database: the constant defaults are metadata-only
-- (PostgreSQL 11+), the CHECKs scan a table with one row per tenant, and
-- "chatbot_live_sessions" is small. `SET LOCAL lock_timeout` bounds each wait
-- to 5 s and Prisma runs this file as one transaction. If it fails on lock
-- timeout, run
--   prisma migrate resolve --rolled-back 20261113010000_live_conversation_slice2
-- and redeploy at low traffic.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "chatbot_attention_settings"
  DROP CONSTRAINT IF EXISTS "chatbot_attention_settings_start_timeout_check",
  DROP CONSTRAINT IF EXISTS "chatbot_attention_settings_template_language_check",
  ADD COLUMN IF NOT EXISTS "startTimeoutSeconds" INTEGER NOT NULL DEFAULT 120,
  ADD COLUMN IF NOT EXISTS "templateLanguageCode" TEXT NOT NULL DEFAULT 'es_MX',
  ADD CONSTRAINT "chatbot_attention_settings_start_timeout_check"
    CHECK ("startTimeoutSeconds" BETWEEN 30 AND 600),
  ADD CONSTRAINT "chatbot_attention_settings_template_language_check"
    CHECK ("templateLanguageCode" ~ '^[a-z]{2,3}(_[A-Z]{2})?$');

ALTER TABLE "chatbot_live_sessions" ADD COLUMN IF NOT EXISTS "startDeadlineAt" TIMESTAMP(3);

ALTER TABLE "chatbot_conversations" ADD COLUMN IF NOT EXISTS "windowClosedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "chatbot_live_sessions_starting_deadline_idx"
  ON "chatbot_live_sessions" ("startDeadlineAt")
  WHERE "state" = 'STARTING' AND "startDeadlineAt" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "chatbot_conversations_human_idx"
  ON "chatbot_conversations" ("tenantId", "conversationRef")
  WHERE "mode" = 'HUMAN';

CREATE OR REPLACE FUNCTION "conversation_messages_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Nested AND the tenant no longer exists: only the tenant cascade is
    -- exempt (kept from 20261112030000; a DELETE issued by another trigger
    -- while the tenant exists is still rejected).
    IF pg_trigger_depth() > 1
       AND NOT EXISTS (SELECT 1 FROM "tenants" WHERE "id" = OLD."tenantId") THEN
      RETURN OLD;
    END IF;
    IF coalesce(current_setting('houndfe.conversation_retention', true), '') = 'on'
       AND OLD."purgeAfter" < now() THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'conversation_messages are immutable (DELETE rejected)'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF (to_jsonb(NEW) - 'deliveryStatus') = (to_jsonb(OLD) - 'deliveryStatus')
     AND "conversation_delivery_can_advance"(OLD."deliveryStatus"::text, NEW."deliveryStatus"::text) THEN
    RETURN NEW;
  END IF;
  -- Unit 11: the wamid of a staff message, assigned once by the delivery outcome.
  IF OLD."waMessageId" IS NULL AND NEW."waMessageId" IS NOT NULL
     AND OLD."author" = 'STAFF' AND OLD."direction" = 'OUT'
     AND (to_jsonb(NEW) - 'deliveryStatus' - 'waMessageId')
       = (to_jsonb(OLD) - 'deliveryStatus' - 'waMessageId')
     AND "conversation_delivery_can_advance"(OLD."deliveryStatus"::text, NEW."deliveryStatus"::text) THEN
    RETURN NEW;
  END IF;
  -- S16 4: Meta said "window closed" (131047) after the bot sent it.
  IF OLD."author" = 'STAFF' AND OLD."direction" = 'OUT'
     AND OLD."deliveryStatus"::text = 'SENT' AND NEW."deliveryStatus"::text = 'DEFERRED'
     AND (to_jsonb(NEW) - 'deliveryStatus') = (to_jsonb(OLD) - 'deliveryStatus') THEN
    RETURN NEW;
  END IF;
  -- S16 4: the resend of a DEFERRED staff message replaces the dead wamid.
  IF OLD."author" = 'STAFF' AND OLD."direction" = 'OUT'
     AND OLD."deliveryStatus"::text = 'DEFERRED'
     AND OLD."waMessageId" IS NOT NULL AND NEW."waMessageId" IS NOT NULL
     AND NEW."waMessageId" <> OLD."waMessageId"
     AND (to_jsonb(NEW) - 'deliveryStatus' - 'waMessageId')
       = (to_jsonb(OLD) - 'deliveryStatus' - 'waMessageId')
     AND "conversation_delivery_can_advance"(OLD."deliveryStatus"::text, NEW."deliveryStatus"::text) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'conversation_messages are immutable (UPDATE rejected)'
    USING ERRCODE = 'restrict_violation';
END;
$$;
