-- Link TRANSFER_RECEIPT requests created before fix/receipt-request-conversation
-- to their customer's mirrored chat, so the staff "Conversación" panel shows it.
--
-- Same rule as ChatbotRequestWrapper.wrapReceipt: only requests with a real
-- phone key (not "unknown:<receiptId>") and only when exactly one chat of the
-- same tenant has that customerKey. Rows that already have a conversationRef
-- are never touched, so it is safe to run twice. The window columns are filled
-- only where the request has none.
--
-- Usage in psql (production database of houndfe-backend):
--   1. Dry run: run the SELECT block alone and read the rows.
--   2. Apply:   BEGIN; <UPDATE block>; check the RETURNING rows; COMMIT;
--               (ROLLBACK; if anything looks wrong).

-- [dry-run]
SELECT r."id", r."folio", r."status", c."conversationRef" IS NOT NULL AS "linkable"
FROM "chatbot_requests" r
JOIN "chatbot_conversations" c
  ON c."tenantId" = r."tenantId" AND c."customerKey" = r."customerKey"
WHERE r."subtype" = 'TRANSFER_RECEIPT'
  AND r."conversationRef" IS NULL
  AND r."customerKey" NOT LIKE 'unknown:%'
  AND (SELECT count(*) FROM "chatbot_conversations" c2
       WHERE c2."tenantId" = r."tenantId" AND c2."customerKey" = r."customerKey") = 1;

-- [apply]
UPDATE "chatbot_requests" r
SET "conversationRef" = c."conversationRef",
    "lastCustomerMessageAt" = COALESCE(r."lastCustomerMessageAt", c."lastCustomerMessageAt"),
    "whatsappWindowClosesAt" = COALESCE(
      r."whatsappWindowClosesAt",
      c."lastCustomerMessageAt" + interval '24 hours')
FROM "chatbot_conversations" c
WHERE c."tenantId" = r."tenantId"
  AND c."customerKey" = r."customerKey"
  AND r."subtype" = 'TRANSFER_RECEIPT'
  AND r."conversationRef" IS NULL
  AND r."customerKey" NOT LIKE 'unknown:%'
  AND (SELECT count(*) FROM "chatbot_conversations" c2
       WHERE c2."tenantId" = r."tenantId" AND c2."customerKey" = r."customerKey") = 1
RETURNING r."id", r."folio", r."status";
