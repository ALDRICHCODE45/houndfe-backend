-- restock-backorder / T2b — the new terminal feed outcome `PROVIDER_REJECTED`
-- (contract v1 §10), second file of the backorder feed change (it follows
-- 20261121000000_backorder_feed, which adds the subject, the reason column and
-- the indexes). It is a separate file because the first one had already been
-- applied to the shared test database when the closed outcome set of
-- "chatbot_feed_items_outcome_chk" (migrations 20261110050000 and
-- 20261110060000) was found to refuse the new value: an applied migration is
-- never edited.
--
-- Additive only: the CHECK is WIDENED by exactly one value. Every existing row
-- satisfies it (the old set is a subset). "chatbot_feed_items_ack_state_chk" is
-- untouched and already right: PROVIDER_REJECTED is not a deferral, so it is
-- terminal (ackedAt set) and carries its attempt identity like every outcome.
-- The old constraint is dropped and the new one added in this same
-- transaction, so there is no window without the outcome guarantee.
--
-- Locks: ACCESS EXCLUSIVE on "chatbot_feed_items" until commit (Prisma runs the
-- file in one transaction); the CHECK validates with one sequential scan of a
-- table that is purged after 30 days. `SET LOCAL lock_timeout` bounds the wait
-- to 5 s. Run it at low traffic.
--
-- Rollback (manual, only while no PROVIDER_REJECTED outcome exists):
--   UPDATE "chatbot_feed_items" SET "outcome" = 'DELIVERY_UNKNOWN',
--     "outcomeReason" = NULL WHERE "outcome" = 'PROVIDER_REJECTED';
--   ALTER TABLE "chatbot_feed_items"
--     DROP CONSTRAINT "chatbot_feed_items_outcome_chk",
--     ADD CONSTRAINT "chatbot_feed_items_outcome_chk" CHECK (
--       "outcome" IS NULL OR "outcome" IN
--         ('PROVIDER_ACCEPTED', 'DELIVERY_UNKNOWN', 'DEFERRED_WINDOW_CLOSED',
--          'DEFERRED_HUMAN_SESSION', 'STALE'));
SET LOCAL lock_timeout = '5s';

ALTER TABLE "chatbot_feed_items"
  DROP CONSTRAINT "chatbot_feed_items_outcome_chk";
ALTER TABLE "chatbot_feed_items"
  ADD CONSTRAINT "chatbot_feed_items_outcome_chk" CHECK (
    "outcome" IS NULL OR "outcome" IN
      ('PROVIDER_ACCEPTED', 'DELIVERY_UNKNOWN', 'DEFERRED_WINDOW_CLOSED',
       'DEFERRED_HUMAN_SESSION', 'STALE', 'PROVIDER_REJECTED')
  ) NOT VALID;
ALTER TABLE "chatbot_feed_items" VALIDATE CONSTRAINT "chatbot_feed_items_outcome_chk";
