-- human-intervention / unit 9 verify fixes (S12 unread marker, S2 media
-- retention, N3, N4, N5).
--
-- 1. S12: the durable "staff read" marker of a conversation
--    ("lastStaffReadSeq", "lastStaffReadAt") and the partial index that counts
--    the customer messages after it.
-- 2. S2: "conversation_media_intents", the durable record of every object the
--    upload is about to write (and of every object whose row was deleted), and
--    "conversation_media_orphan_sweep", the cursor of the bucket sweep.
-- 3. N5: the delete exemption of the immutability triggers is narrowed from
--    "any nested trigger" (pg_trigger_depth() > 1) to "the tenant is gone".
--
-- Safe on a populated database:
--   * "chatbot_conversations" gets two columns. ADD COLUMN with a constant
--     DEFAULT (and one nullable column) is a catalog-only change in PostgreSQL
--     11+; no table rewrite. The backfill UPDATE touches one row per chat
--     (thousands), not per message.
--   * The new partial index is built over "conversation_messages" with a plain
--     CREATE INDEX (SHARE lock: writes wait, reads do not). The mirror is new
--     (unit 9), so the table is small; it must not be copied to a much larger
--     table later without CONCURRENTLY.
--   * Two new, empty tables and one AFTER DELETE trigger on
--     "conversation_media" (a table that only ever holds file descriptors).
--   * The two trigger functions are replaced with CREATE OR REPLACE (the
--     triggers keep pointing at them).
--   `SET LOCAL lock_timeout` bounds every wait to 5 s and Prisma runs this file
--   as one transaction, so on a timeout nothing is applied.
-- Deploy note: deploy at low traffic. If it fails on lock timeout, run
--   prisma migrate resolve --rolled-back 20261112030000_conversation_unread_media_intents
-- and redeploy.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------- 1. S12

-- The highest `seq` any staff member has been shown through the conversation
-- read, and when that last moved. One marker per CONVERSATION: the requests of a
-- chat share one timeline, so opening it through any of them clears all of them.
ALTER TABLE "chatbot_conversations"
  ADD COLUMN "lastStaffReadSeq" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastStaffReadAt" TIMESTAMP(3);

ALTER TABLE "chatbot_conversations"
  ADD CONSTRAINT "chatbot_conversations_read_seq_chk" CHECK ("lastStaffReadSeq" >= 0);

-- Until now the counter was always 0: the chats that already exist start as
-- "read" so the first deploy does not flood every inbox row with the history.
UPDATE "chatbot_conversations" SET "lastStaffReadSeq" = "nextSeq" - 1;

-- Counting the customer messages after the marker is an index range scan (and
-- index-only when the visibility map allows it), never a heap walk.
CREATE INDEX "conversation_messages_customer_seq_idx"
  ON "conversation_messages"("conversationId", "seq") WHERE "author" = 'CUSTOMER';

-- ---------------------------------------------------------------- 2. S2

-- One row per object that may exist in storage without a "conversation_media"
-- row owning it:
--   UPLOAD       written BEFORE the object is; the upload deletes it once the
--                media row exists, or once it has deleted the object. A crash in
--                between leaves it, and the retention sweep reconciles it after
--                "dueAt" (an hour later): the row exists -> the intent is
--                dropped; no row -> the object is deleted, then the intent.
--   ROW_DELETED  written by the trigger below when a media row that still owns
--                an object is deleted (a tenant deletion cascades the rows and
--                would otherwise leave the files): due at once.
-- A failed delete keeps the row ("attempts", "lastErrorAt") and is retried; the
-- row goes only after the delete succeeded. There is NO foreign key to "tenants"
-- on purpose: the row must outlive the tenant it was written for.
CREATE TABLE "conversation_media_intents" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastErrorAt" TIMESTAMP(3),
    "leaseUntil" TIMESTAMP(3),

    CONSTRAINT "conversation_media_intents_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "conversation_media_intents_reason_chk" CHECK ("reason" IN ('UPLOAD', 'ROW_DELETED'))
);

CREATE INDEX "conversation_media_intents_due_idx" ON "conversation_media_intents"("dueAt");

-- The cursor of the bucket sweep (`conversation-media/` objects that no row and
-- no intent own, older than a day). One row; "leaseUntil" keeps replicas from
-- scanning the same page.
CREATE TABLE "conversation_media_orphan_sweep" (
    "id" TEXT NOT NULL,
    "cursor" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_media_orphan_sweep_pkey" PRIMARY KEY ("id")
);

INSERT INTO "conversation_media_orphan_sweep" ("id") VALUES ('conversation-media');

-- A media row that still owns an object must never disappear without the object
-- being scheduled for deletion. The retention purge deletes only rows it already
-- purged ("storageKey" NULL), which write nothing here.
CREATE FUNCTION "conversation_media_tombstone"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."storageKey" IS NOT NULL THEN
    INSERT INTO "conversation_media_intents" ("id", "tenantId", "storageKey", "reason", "dueAt")
    VALUES (OLD."id", OLD."tenantId", OLD."storageKey", 'ROW_DELETED', now())
    ON CONFLICT ("id") DO UPDATE SET "reason" = 'ROW_DELETED', "dueAt" = now();
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "conversation_media_tombstone"
  AFTER DELETE ON "conversation_media"
  FOR EACH ROW EXECUTE FUNCTION "conversation_media_tombstone"();

-- ---------------------------------------------------------------- 3. N5

-- The exemption of the two immutability triggers used to be
-- `pg_trigger_depth() > 1`: ANY nested trigger could delete messages. The only
-- nested delete that is legitimate is the tenant deletion cascading through its
-- chats, and then the tenant row is already gone when the cascade runs (AFTER
-- triggers fire once the statement's own deletes are visible). So the exemption
-- is now "nested AND the tenant no longer exists".
CREATE OR REPLACE FUNCTION "conversation_messages_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
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
  RAISE EXCEPTION 'conversation_messages are immutable (UPDATE rejected)'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE OR REPLACE FUNCTION "chatbot_conversations_guard_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1
     AND NOT EXISTS (SELECT 1 FROM "tenants" WHERE "id" = OLD."tenantId") THEN
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
