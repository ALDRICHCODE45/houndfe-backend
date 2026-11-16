-- A TRANSFER_RECEIPT request is created by the backend when the bot attaches
-- a receipt to a sale; that upload carries no conversationRef. The wrapper now
-- links the request to the one mirrored chat of the tenant whose customerKey
-- is the sale customer's phone key, so this lookup needs an index.
--
-- Additive. SHARE lock on chatbot_conversations (blocks writes, not reads)
-- while it builds: the table holds one row per WhatsApp customer, so it is
-- milliseconds. lock_timeout keeps a held lock from stalling the deploy.
SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS "chatbot_conversations_tenantId_customerKey_idx"
  ON "chatbot_conversations" ("tenantId", "customerKey");
