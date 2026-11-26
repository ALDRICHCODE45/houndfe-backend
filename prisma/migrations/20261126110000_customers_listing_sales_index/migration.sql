-- customers-listing / T1 — indexes behind GET /customers/listing
-- (docs/proposals/customers-list-contract.md §12.1).
--
-- 1. "sales_tenant_customer_confirmed_idx": partial covering index over the
--    CONFIRMED sales that have a customer. The listing metrics LATERAL
--    (src/customers/listing/customer-sales-metrics.sql.ts) filters
--    "tenantId" = $t AND "customerId" = c.id AND "status" = 'CONFIRMED' and
--    reads only the INCLUDE columns, so it is an index-only scan per customer.
--    The predicate must stay textually compatible with that fragment.
-- 2. "customer_addresses_tenant_customer_created_idx": the primary address
--    (oldest by "createdAt", then "id") of each page row.
--
-- Additive only, hand-written. Index 1 is migration-only (Prisma cannot
-- express a partial or INCLUDE index); prisma/schema.prisma documents it with
-- a comment on `Sale`. Index 2 is a plain index, so `CustomerAddress` declares
-- it with the same name (`@@index(..., map: ...)`) and the schema does not
-- drift from the database.
--
-- A plain CREATE INDEX takes a SHARE lock: reads continue, writes to "sales"
-- and "customer_addresses" wait while each index builds. Deploy off-hours if
-- "sales" is large. `SET LOCAL lock_timeout` bounds the wait for the lock and
-- Prisma runs this file as one transaction, so on a timeout nothing is
-- applied.
-- Deploy note: if it fails on lock timeout, run
--   prisma migrate resolve --rolled-back 20261126110000_customers_listing_sales_index
-- and redeploy.

SET LOCAL lock_timeout = '5s';

CREATE INDEX "sales_tenant_customer_confirmed_idx"
  ON "sales" ("tenantId", "customerId")
  INCLUDE ("totalCents", "openDebtCents", "dueDate", "confirmedAt")
  WHERE "status" = 'CONFIRMED' AND "customerId" IS NOT NULL;

CREATE INDEX "customer_addresses_tenant_customer_created_idx"
  ON "customer_addresses" ("tenantId", "customerId", "createdAt", "id");
