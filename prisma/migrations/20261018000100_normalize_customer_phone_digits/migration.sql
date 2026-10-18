-- customers — canonical digits-only phone parts.
--
-- The POS stored phone parts as typed (for example "+52" and
-- "55 8587 6245") while the chatbot API looks customers up by exact
-- digits-only (tenantId, phoneCountryCode, phone). Those customers were
-- unreachable from the chatbot, and atomic checkout with
-- customer.mode = createIfAbsent would create a duplicate.
--
-- New writes are normalized by the application; this backfills existing
-- rows to the same form: every non-digit removed, NULL when no digit
-- remains. It NEVER merges or deletes customers. The (tenantId,
-- phoneCountryCode, phone) index is not unique, so rows that collapse to
-- the same phone survive side by side for a human to resolve. Read-only
-- report to run BEFORE deploying:
--
--   SELECT "tenantId",
--          NULLIF(regexp_replace("phoneCountryCode", '[^0-9]', '', 'g'), '') AS cc,
--          NULLIF(regexp_replace("phone", '[^0-9]', '', 'g'), '') AS phone,
--          count(*) AS customers,
--          array_agg("id" ORDER BY "createdAt") AS ids
--   FROM "customers"
--   WHERE regexp_replace(coalesce("phone", ''), '[^0-9]', '', 'g') <> ''
--   GROUP BY 1, 2, 3
--   HAVING count(*) > 1;
UPDATE "customers"
SET "phoneCountryCode" = NULLIF(regexp_replace("phoneCountryCode", '[^0-9]', '', 'g'), ''),
    "phone" = NULLIF(regexp_replace("phone", '[^0-9]', '', 'g'), '')
WHERE "phoneCountryCode" ~ '[^0-9]'
   OR "phone" ~ '[^0-9]'
   OR "phoneCountryCode" = ''
   OR "phone" = '';
