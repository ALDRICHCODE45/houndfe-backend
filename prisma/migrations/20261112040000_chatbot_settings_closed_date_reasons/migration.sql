-- human-intervention / T7f (S11): a reason per closed date. Additive: one new
-- column on "chatbot_attention_settings" (one row per tenant, tiny table).
--
-- Safe on a populated database: ADD COLUMN with a constant DEFAULT is a
-- catalog-only change (no table rewrite, PostgreSQL 11+), existing rows read
-- '{}' (no reasons). The CHECK is validated against those rows in the same
-- statement; it scans a table of at most one row per tenant. Both statements
-- take a brief ACCESS EXCLUSIVE lock on this small table; `lock_timeout`
-- bounds the wait to 5 s and Prisma runs the file as one transaction, so on
-- timeout nothing is applied. Recovery: prisma migrate resolve --rolled-back
-- 20261112040000_chatbot_settings_closed_date_reasons, then redeploy.
-- No backfill is needed.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "chatbot_attention_settings"
  ADD COLUMN "closedDateReasons" JSONB NOT NULL DEFAULT '{}';

-- Migration-authoritative (Prisma cannot express it): the reasons are a map
-- date -> text. Keys and lengths are validated by the application.
ALTER TABLE "chatbot_attention_settings"
  ADD CONSTRAINT "chatbot_attention_settings_reasons_chk"
  CHECK (jsonb_typeof("closedDateReasons") = 'object');
