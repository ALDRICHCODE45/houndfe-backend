-- POS Price List Tiers — sale-level price list assignment +
-- explicit-set discriminator (work unit 1).
--
-- Two additive nullable columns on `sales`:
--
-- 1. `globalPriceListId` — nullable FK to `global_price_lists.id`
--    (`@@map("global_price_lists")`). OnDelete: SetNull so deleting a
--    catalog GlobalPriceList cannot cascade-wipe confirmed sale rows.
--    Mirrors the existing `Customer.globalPriceListId` pattern at
--    schema.prisma:1031. Sale-level default list — non-sticky lines
--    reprice tier-aware from this list on every draft mutation.
--
-- 2. `priceListExplicitlySet` — boolean default false. Discriminates
--    "cashier picked a list via PUT /price-list" from "list was
--    auto-seeded by `assignCustomer`". `assignCustomer` only seeds
--    when the flag is false; an explicit PUT (including a null clear)
--    flips it to true and prevents future seeding from clobbering the
--    cashier's choice.
--
-- The columns are fully additive and reversible — no backfill needed
-- (existing sale rows default to NULL/false, which preserves today's
-- "default list" behavior until the new draft mutations run).
--
-- Index note: `globalPriceListId` is intentionally NOT indexed at the
-- table level because the only call path that hits it (price-list
-- read at draft open / reprice) goes through the existing
-- `@@index([tenantId])` + `findUnique` on tenant; the FK column is
-- only ever read as a single-row column on the loaded Sale.

-- AlterTable
ALTER TABLE "sales"
  ADD COLUMN     "globalPriceListId"      TEXT,
  ADD COLUMN     "priceListExplicitlySet" BOOLEAN NOT NULL DEFAULT false;

-- AddForeignKey
ALTER TABLE "sales"
  ADD CONSTRAINT "sales_globalPriceListId_fkey"
  FOREIGN KEY ("globalPriceListId") REFERENCES "global_price_lists"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
