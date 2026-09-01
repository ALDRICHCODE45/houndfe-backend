-- online-catalog-publishing / F1.WU1
-- Additive migration: adds enums, tables, backfills, and constraints for
-- tenant publication gate, variant publication mode, catalog price-list bindings,
-- and stock presentation defaults.
--
-- Migration envelope (M1–M7):
--   M1: Tenant.catalogPublished BOOLEAN NOT NULL DEFAULT false (existing tenants stay hidden)
--   M2: no column change (Product.includeInOnlineCatalog is subordinated to tenant gate)
--   M3: Variant.catalogPublishMode nullable→INHERIT→NOT NULL+DEFAULT
--   M4: bind the sole GlobalPriceList.isDefault=true row as each tenant's catalog default
--   M5: Product.onlineStockPresentation = SYSTEM_STATUS; variant override stays null
--   M6: no data change (hidePriceInOnlineCatalog round-trip only)
--   M7: consistency policy, not schema

-- M4 preflight: existing tenant data requires exactly one global default.
-- A clean pre-seed database may have zero tenants and zero defaults; M4 is then
-- a no-op and seed initialization creates the binding.
DO $$
DECLARE
  default_count INTEGER := (SELECT COUNT(*) FROM "global_price_lists" WHERE "isDefault" = true);
  tenant_count INTEGER := (SELECT COUNT(*) FROM "tenants");
BEGIN
  IF default_count > 1 OR (tenant_count > 0 AND default_count <> 1) THEN
    RAISE EXCEPTION
      'online catalog backfill requires exactly one default GlobalPriceList for existing tenants (defaults: %, tenants: %)',
      default_count, tenant_count;
  END IF;
END $$;

-- Step 1 — Create enums

CREATE TYPE "CatalogPublishMode" AS ENUM (
  'INHERIT',
  'ON',
  'OFF'
);

CREATE TYPE "CatalogStockPresentation" AS ENUM (
  'SYSTEM_STATUS',
  'ABSTRACT_STATUS',
  'CUSTOM_QUANTITY',
  'HIDDEN'
);

-- Step 2 — Add tenant publication gate and stock-presentation default columns
-- (M1; M1 does not change existing product or variant columns)

ALTER TABLE "tenants"
  ADD COLUMN "catalogPublished"      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "catalogStockPresentationDefault"          "CatalogStockPresentation" NOT NULL DEFAULT 'SYSTEM_STATUS',
  ADD COLUMN "catalogStockPresentationDefaultCustomQty" INTEGER;

ALTER TABLE "tenants"
  ADD CONSTRAINT "tenants_catalog_stock_default_custom_qty_nonnegative"
    CHECK (
      "catalogStockPresentationDefaultCustomQty" IS NULL
      OR "catalogStockPresentationDefaultCustomQty" >= 0
    );

CREATE INDEX "tenants_isActive_catalogPublished_name_idx"
  ON "tenants" ("isActive", "catalogPublished", "name");

-- Step 3 — Create the two new join tables (schema only; backfills follow)

CREATE TABLE "tenant_catalog_price_lists" (
  "id"                 TEXT         NOT NULL,
  "tenantId"           TEXT         NOT NULL,
  "globalPriceListId" TEXT         NOT NULL,
  "isCatalogDefault"   BOOLEAN      NOT NULL DEFAULT false,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("id")
);

CREATE TABLE "product_catalog_price_lists" (
  "id"                 TEXT         NOT NULL,
  "tenantId"           TEXT         NOT NULL,
  "productId"          TEXT         NOT NULL,
  "globalPriceListId" TEXT         NOT NULL,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenant_catalog_price_lists_tenantId_globalPriceListId_key"
  ON "tenant_catalog_price_lists" ("tenantId", "globalPriceListId");

CREATE UNIQUE INDEX "product_catalog_price_lists_tenantId_productId_globalPriceListId_key"
  ON "product_catalog_price_lists" ("tenantId", "productId", "globalPriceListId");

CREATE INDEX "tenant_catalog_price_lists_tenantId_idx"
  ON "tenant_catalog_price_lists" ("tenantId");

CREATE INDEX "product_catalog_price_lists_tenantId_idx"
  ON "product_catalog_price_lists" ("tenantId");

-- Partial unique index: one catalog default per tenant (ADR-3).
CREATE UNIQUE INDEX "tenant_catalog_price_lists_one_default_per_tenant"
  ON "tenant_catalog_price_lists" ("tenantId")
  WHERE "isCatalogDefault" = true;

-- Step 4 — Add foreign keys (after tables exist)

ALTER TABLE "tenant_catalog_price_lists"
  ADD CONSTRAINT "tenant_catalog_price_lists_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;

ALTER TABLE "tenant_catalog_price_lists"
  ADD CONSTRAINT "tenant_catalog_price_lists_globalPriceListId_fkey"
    FOREIGN KEY ("globalPriceListId") REFERENCES "global_price_lists" ("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;

ALTER TABLE "product_catalog_price_lists"
  ADD CONSTRAINT "product_catalog_price_lists_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;

ALTER TABLE "product_catalog_price_lists"
  ADD CONSTRAINT "product_catalog_price_lists_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "products" ("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;

ALTER TABLE "product_catalog_price_lists"
  ADD CONSTRAINT "product_catalog_price_lists_globalPriceListId_fkey"
    FOREIGN KEY ("globalPriceListId") REFERENCES "global_price_lists" ("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;

-- Step 5 — Add product stock-presentation columns and M5 backfill
-- (M5: neutral presentation for existing products; variant null means inherit)

ALTER TABLE "products"
  ADD COLUMN "onlineStockPresentation"          "CatalogStockPresentation",
  ADD COLUMN "onlineStockPresentationCustomQty" INTEGER;

ALTER TABLE "products"
  ADD CONSTRAINT "products_online_stock_custom_qty_nonnegative"
    CHECK (
      "onlineStockPresentationCustomQty" IS NULL
      OR "onlineStockPresentationCustomQty" >= 0
    );

UPDATE "products"
SET "onlineStockPresentation" = 'SYSTEM_STATUS'::"CatalogStockPresentation"
WHERE "onlineStockPresentation" IS NULL;

-- Step 6 — Add variant publication mode column and M3 backfill
-- (M3: stage nullable, backfill INHERIT, apply DEFAULT + NOT NULL)

ALTER TABLE "variants"
  ADD COLUMN "catalogPublishMode" "CatalogPublishMode";

UPDATE "variants"
SET "catalogPublishMode" = 'INHERIT'::"CatalogPublishMode"
WHERE "catalogPublishMode" IS NULL;

ALTER TABLE "variants"
  ALTER COLUMN "catalogPublishMode"
    SET DEFAULT 'INHERIT'::"CatalogPublishMode";

-- Apply NOT NULL constraint (separate statement — PostgreSQL syntax).
ALTER TABLE "variants"
  ALTER COLUMN "catalogPublishMode" SET NOT NULL;

-- Step 7 — Add variant stock-presentation columns (no separate backfill;
-- M5 already cleared null variants; null here means inherit at read time)

ALTER TABLE "variants"
  ADD COLUMN "onlineStockPresentation"          "CatalogStockPresentation",
  ADD COLUMN "onlineStockPresentationCustomQty" INTEGER;

ALTER TABLE "variants"
  ADD CONSTRAINT "variants_online_stock_custom_qty_nonnegative"
    CHECK (
      "onlineStockPresentationCustomQty" IS NULL
      OR "onlineStockPresentationCustomQty" >= 0
    );

CREATE INDEX "variants_productId_catalogPublishMode_idx"
  ON "variants" ("productId", "catalogPublishMode");

CREATE INDEX "price_lists_tenantId_globalPriceListId_priceCents_idx"
  ON "price_lists" ("tenantId", "globalPriceListId", "priceCents");

CREATE INDEX "variant_prices_tenantId_priceListId_priceCents_idx"
  ON "variant_prices" ("tenantId", "priceListId", "priceCents");

-- Step 8 — M4: idempotent catalog-default binding for tenants with no binding
-- (M4: bind the sole GlobalPriceList.isDefault=true as each tenant's catalog
-- default; only for tenants that have zero rows in tenant_catalog_price_lists)

INSERT INTO "tenant_catalog_price_lists" (
  "id",
  "tenantId",
  "globalPriceListId",
  "isCatalogDefault",
  "createdAt",
  "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  t."id",
  g."id",
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "tenants" t
CROSS JOIN "global_price_lists" g
WHERE g."isDefault" = true
  AND NOT EXISTS (
    SELECT 1
    FROM "tenant_catalog_price_lists" existing
    WHERE existing."tenantId" = t."id"
  )
ON CONFLICT ("tenantId", "globalPriceListId") DO NOTHING;

-- M2: data-neutral — no column change to Product.includeInOnlineCatalog.
-- The existing default (true) remains but is now subordinated to the tenant
-- gate in all effective-publication queries (enforced in WU5 code, not here).
--
-- M6: data-neutral — hidePriceInOnlineCatalog already exists on Product with
-- default false; WU4 adds the authenticated DTO round-trip without data change.
--
-- M7: consistency policy — a published tenant whose default context has no
-- valid selected-context price rows excludes that product from listing and
-- rejects it in cart. This is enforced in WU5/WU7 application code.
