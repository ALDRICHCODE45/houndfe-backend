-- human-intervention / unit 9 (contract §3.6, §6.2, §10.1): the conversation
-- mirror ("chatbot_conversations", "conversation_messages"), the private media
-- registry ("conversation_media"), the immutability triggers of §6.2 and one
-- partial index on "chatbot_requests" for the conversationRef lookup.
--
-- Safe on a populated database:
--   * Three new, empty tables; nothing is rewritten and no existing row changes.
--   * The only statement on an existing table is a partial index on
--     "chatbot_requests" ("tenantId", "conversationRef") WHERE "conversationRef"
--     IS NOT NULL. A plain CREATE INDEX takes a SHARE lock (writes wait, reads
--     do not) for as long as the build lasts: the table holds requests, not
--     messages (thousands of rows), so that is milliseconds.
--   * The tenant FKs take a brief SHARE ROW EXCLUSIVE lock on "tenants".
--   `SET LOCAL lock_timeout` bounds every wait to 5 s and Prisma runs this file
--   as one transaction, so on a timeout nothing is applied.
-- Deploy note: deploy at low traffic. If it fails on lock timeout, run
--   prisma migrate resolve --rolled-back 20261112020000_conversation_mirror
-- and redeploy.

SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "ConversationMode" AS ENUM ('BOT', 'HUMAN');
CREATE TYPE "ConversationMessageDirection" AS ENUM ('IN', 'OUT');
CREATE TYPE "ConversationMessageAuthor" AS ENUM ('CUSTOMER', 'BOT', 'STAFF', 'SYSTEM');
CREATE TYPE "ConversationMessageType" AS ENUM ('TEXT', 'IMAGE', 'STICKER', 'DOCUMENT', 'AUDIO', 'TEMPLATE', 'SYSTEM', 'UNSUPPORTED');
CREATE TYPE "ConversationDeliveryStatus" AS ENUM ('QUEUED', 'DEFERRED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "chatbot_conversations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "conversationRef" VARCHAR(200) NOT NULL,
    "customerKey" TEXT,
    "lastCustomerMessageAt" TIMESTAMP(3),
    "mode" "ConversationMode" NOT NULL DEFAULT 'BOT',
    "handoffEpoch" INTEGER NOT NULL DEFAULT 0,
    "nextSeq" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chatbot_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_media" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storageKey" TEXT,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purgeAfter" TIMESTAMP(3) NOT NULL,
    "purgedAt" TIMESTAMP(3),
    "purgeAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastPurgeErrorAt" TIMESTAMP(3),
    "purgeLeaseUntil" TIMESTAMP(3),

    CONSTRAINT "conversation_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_messages" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "direction" "ConversationMessageDirection" NOT NULL,
    "author" "ConversationMessageAuthor" NOT NULL,
    "staffUserId" TEXT,
    "waMessageId" VARCHAR(255),
    "clientMessageId" TEXT,
    "type" "ConversationMessageType" NOT NULL,
    "text" VARCHAR(4096),
    "mediaId" TEXT,
    "providerTimestamp" TIMESTAMP(3),
    "observedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveryStatus" "ConversationDeliveryStatus",
    "purgeAfter" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chatbot_conversations_tenantId_conversationRef_key" ON "chatbot_conversations"("tenantId", "conversationRef");
CREATE UNIQUE INDEX "chatbot_conversations_tenantId_id_key" ON "chatbot_conversations"("tenantId", "id");
CREATE UNIQUE INDEX "conversation_media_tenantId_id_key" ON "conversation_media"("tenantId", "id");
CREATE UNIQUE INDEX "conversation_media_tenantId_idempotencyKey_key" ON "conversation_media"("tenantId", "idempotencyKey");
CREATE UNIQUE INDEX "conversation_messages_conversationId_seq_key" ON "conversation_messages"("conversationId", "seq");
CREATE UNIQUE INDEX "conversation_messages_tenantId_waMessageId_key" ON "conversation_messages"("tenantId", "waMessageId");
CREATE UNIQUE INDEX "conversation_messages_tenantId_clientMessageId_key" ON "conversation_messages"("tenantId", "clientMessageId");

-- Retention (§10.1 "Purga de 12 meses"): the oldest due rows, in batches.
CREATE INDEX "conversation_messages_purgeAfter_idx" ON "conversation_messages"("purgeAfter");
CREATE INDEX "conversation_media_due_idx" ON "conversation_media"("purgeAfter") WHERE "purgedAt" IS NULL;

-- "Is this file still referenced?" (media row cleanup) and the media proxy.
CREATE INDEX "conversation_messages_media_idx"
  ON "conversation_messages"("tenantId", "mediaId") WHERE "mediaId" IS NOT NULL;

-- The inbox's request -> conversation link goes request.conversationRef ->
-- conversation; the reverse (a customer message -> the open requests of that
-- chat, for the realtime event) needs this lookup.
CREATE INDEX "chatbot_requests_conversation_ref_idx"
  ON "chatbot_requests"("tenantId", "conversationRef") WHERE "conversationRef" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "chatbot_conversations" ADD CONSTRAINT "chatbot_conversations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_media" ADD CONSTRAINT "conversation_media_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_tenantId_conversationId_fkey" FOREIGN KEY ("tenantId", "conversationId") REFERENCES "chatbot_conversations"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CHECKs: the shape the contract fixes (§3.6, §12.5).
ALTER TABLE "chatbot_conversations"
  ADD CONSTRAINT "chatbot_conversations_next_seq_chk" CHECK ("nextSeq" >= 1),
  ADD CONSTRAINT "chatbot_conversations_epoch_chk" CHECK ("handoffEpoch" >= 0);

ALTER TABLE "conversation_media"
  ADD CONSTRAINT "conversation_media_size_chk" CHECK ("sizeBytes" > 0 AND "sizeBytes" <= 10485760),
  ADD CONSTRAINT "conversation_media_purged_chk" CHECK (("purgedAt" IS NULL) = ("storageKey" IS NOT NULL));

ALTER TABLE "conversation_messages"
  ADD CONSTRAINT "conversation_messages_seq_chk" CHECK ("seq" > 0),
  -- The customer is the only incoming author; the bot, staff and the timeline
  -- marks are outgoing.
  ADD CONSTRAINT "conversation_messages_author_chk" CHECK (
    ("direction" = 'IN' AND "author" = 'CUSTOMER')
    OR ("direction" = 'OUT' AND "author" IN ('BOT', 'STAFF', 'SYSTEM'))),
  -- Delivery belongs to what we send, and a timeline mark is never "delivered".
  ADD CONSTRAINT "conversation_messages_delivery_chk" CHECK (
    "deliveryStatus" IS NULL OR ("direction" = 'OUT' AND "author" <> 'SYSTEM')),
  ADD CONSTRAINT "conversation_messages_staff_chk" CHECK (("author" = 'STAFF') = ("staffUserId" IS NOT NULL)),
  -- A file message points at a file; nothing else does. Text needs words.
  ADD CONSTRAINT "conversation_messages_media_chk" CHECK (
    ("type" IN ('IMAGE', 'STICKER', 'DOCUMENT', 'AUDIO')) = ("mediaId" IS NOT NULL)),
  ADD CONSTRAINT "conversation_messages_text_chk" CHECK ("type" <> 'TEXT' OR "text" IS NOT NULL);

-- §6.2: forward-only delivery status. Same rule as
-- src/conversations/domain/delivery-status.ts (compared pair by pair in
-- conversation-mirror.integration.spec.ts):
--   QUEUED -> [DEFERRED ->] SENT -> DELIVERED -> READ, and FAILED / UNKNOWN from
--   any state before delivery; nothing leaves FAILED, UNKNOWN or READ.
CREATE FUNCTION "conversation_delivery_can_advance"(old_status text, new_status text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN old_status IS NULL OR new_status IS NULL THEN false
    WHEN new_status IN ('FAILED', 'UNKNOWN') THEN old_status IN ('QUEUED', 'DEFERRED', 'SENT')
    ELSE coalesce(
      (CASE new_status WHEN 'QUEUED' THEN 0 WHEN 'DEFERRED' THEN 1 WHEN 'SENT' THEN 2
                       WHEN 'DELIVERED' THEN 3 WHEN 'READ' THEN 4 END)
      > (CASE old_status WHEN 'QUEUED' THEN 0 WHEN 'DEFERRED' THEN 1 WHEN 'SENT' THEN 2
                         WHEN 'DELIVERED' THEN 3 WHEN 'READ' THEN 4 END),
      false)
  END
$$;

-- §6.2: conversation_messages is immutable.
--   UPDATE: rejected, except `deliveryStatus` moving forward with every other
--           column unchanged (to_jsonb comparison, so a column added later is
--           immutable by default).
--   DELETE: rejected, except
--           * the tenant cascade (the RI trigger is depth 1, this one depth 2),
--           * the retention purge: the application has a single database login,
--             so "the retention role" is a transaction-local marker only the
--             purge sets (`SET LOCAL houndfe.conversation_retention = 'on'`),
--             AND the row must be due (`purgeAfter < now()`).
-- TRUNCATE fires no row trigger, so the test reset (TRUNCATE tenants CASCADE)
-- keeps working.
CREATE FUNCTION "conversation_messages_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
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
  RAISE EXCEPTION 'conversation_messages are immutable (UPDATE rejected)'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "conversation_messages_immutable"
  BEFORE UPDATE OR DELETE ON "conversation_messages"
  FOR EACH ROW EXECUTE FUNCTION "conversation_messages_immutable"();

-- Deleting a conversation row directly would cascade to its messages and skip
-- the retention rule above (the cascade is depth 2 there). So a direct DELETE
-- of a conversation is allowed only when it has no messages; the tenant cascade
-- (depth > 1) passes.
CREATE FUNCTION "chatbot_conversations_guard_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  IF EXISTS (
    SELECT 1 FROM "conversation_messages" WHERE "conversationId" = OLD."id"
  ) THEN
    RAISE EXCEPTION 'a conversation with messages cannot be deleted (retention removes its messages first)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "chatbot_conversations_guard_delete"
  BEFORE DELETE ON "chatbot_conversations"
  FOR EACH ROW EXECUTE FUNCTION "chatbot_conversations_guard_delete"();
