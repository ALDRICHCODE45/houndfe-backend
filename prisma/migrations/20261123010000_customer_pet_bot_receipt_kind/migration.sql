-- customer-pets / T2 (contract §7): the bot's idempotent pet create keeps its
-- receipt in chatbot_bot_receipts with kind CUSTOMER_PET_CREATE. The kind CHECK
-- (last set by 20261114000000_scheduled_conversations) must allow it.
-- Same DROP / ADD NOT VALID / VALIDATE pattern as that migration; no data change.
ALTER TABLE "chatbot_bot_receipts"
  DROP CONSTRAINT IF EXISTS "chatbot_bot_receipts_kind_chk",
  ADD CONSTRAINT "chatbot_bot_receipts_kind_chk"
    CHECK ("kind" IN ('CREATE', 'CANCEL', 'RESCHEDULE', 'CUSTOMER_PET_CREATE')) NOT VALID;
ALTER TABLE "chatbot_bot_receipts" VALIDATE CONSTRAINT "chatbot_bot_receipts_kind_chk";
