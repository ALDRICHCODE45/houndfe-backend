-- Inventory journal storage (O1): immutable stock movements, bucket CAS versions,
-- adjustment receipts, and the S1 automatic "Apertura" for existing stock.

-- CreateEnum
CREATE TYPE "StockMovementBucketKind" AS ENUM ('PRODUCT_UNTRACKED', 'VARIANT', 'LOT');

-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('OPENING', 'INITIAL', 'ADJUSTMENT', 'SALE', 'SALE_CANCELLATION', 'REMOVAL');

-- CreateEnum
CREATE TYPE "StockAdjustmentReason" AS ENUM ('PHYSICAL_COUNT', 'DAMAGE', 'EXPIRED', 'THEFT_LOSS', 'DATA_ENTRY_CORRECTION', 'OTHER');

-- CreateEnum
CREATE TYPE "StockRemovalCause" AS ENUM ('VARIANT_DELETED', 'PRODUCT_DELETED', 'PRODUCT_CONVERTED_TO_SERVICE', 'FIRST_VARIANT_ZEROING');

-- CreateEnum
CREATE TYPE "StockMovementGroupType" AS ENUM ('SALE', 'ADJUSTMENT', 'PRODUCT');

-- CreateEnum
CREATE TYPE "InventoryAdjustmentOperation" AS ENUM ('ADJUST');

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "stockVersion" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "variants" ADD COLUMN     "stockVersion" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "lots" ADD COLUMN     "stockVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "lotId" TEXT,
    "productName" TEXT NOT NULL,
    "variantLabel" TEXT,
    "lotNumber" TEXT,
    "bucketKind" "StockMovementBucketKind" NOT NULL,
    "type" "StockMovementType" NOT NULL,
    "reason" "StockAdjustmentReason",
    "note" TEXT,
    "removalCause" "StockRemovalCause",
    "delta" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "productBalanceAfter" INTEGER NOT NULL,
    "groupType" "StockMovementGroupType" NOT NULL,
    "groupId" TEXT NOT NULL,
    "actorId" TEXT,
    "actorDisplayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_adjustment_receipts" (
    "tenantId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "operation" "InventoryAdjustmentOperation" NOT NULL,
    "target" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "responseBody" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "inventory_adjustment_receipt_namespace_pk" PRIMARY KEY ("tenantId","actorId","operation","target","idempotencyKey")
);

-- CreateIndex
CREATE INDEX "stock_movements_kardex_idx" ON "stock_movements"("tenantId", "productId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "stock_movements_group_idx" ON "stock_movements"("tenantId", "groupType", "groupId");

-- CreateIndex
CREATE INDEX "inventory_adjustment_receipts_tenantId_groupId_idx" ON "inventory_adjustment_receipts"("tenantId", "groupId");

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_adjustment_receipts" ADD CONSTRAINT "inventory_adjustment_receipts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Journal rows are signed, non-zero movements that never leave a negative balance.
ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_delta_check" CHECK ("delta" <> 0),
  ADD CONSTRAINT "stock_movements_balance_check" CHECK ("balanceAfter" >= 0 AND "productBalanceAfter" >= 0),
  ADD CONSTRAINT "stock_movements_bucket_check" CHECK (
    ("bucketKind" = 'PRODUCT_UNTRACKED' AND "variantId" IS NULL AND "lotId" IS NULL) OR
    ("bucketKind" = 'VARIANT' AND "variantId" IS NOT NULL AND "lotId" IS NULL) OR
    ("bucketKind" = 'LOT' AND "variantId" IS NULL AND "lotId" IS NOT NULL));

-- S1 opening, step 1: invariant products.quantity >= sum(lots.quantity). Where the
-- stored lot sum is larger, the product quantity is raised to the lot sum.
UPDATE "products" p
   SET "quantity" = l."total", "updatedAt" = NOW()
  FROM (SELECT "productId", SUM("quantity")::int AS "total" FROM "lots" GROUP BY "productId") l
 WHERE p."id" = l."productId" AND p."hasVariants" = false AND p."quantity" < l."total";

-- S1 opening, step 2: one OPENING movement per non-zero bucket. Buckets are the
-- untracked portion (quantity - sum(lots)) of each non-variant product, each lot
-- and each variant. Rows of one product get consecutive milliseconds so the kardex
-- order (createdAt desc, id desc) matches the running productBalanceAfter.
INSERT INTO "stock_movements" (
  "id", "tenantId", "productId", "variantId", "lotId", "productName", "variantLabel", "lotNumber",
  "bucketKind", "type", "delta", "balanceAfter", "productBalanceAfter",
  "groupType", "groupId", "actorId", "actorDisplayName", "createdAt")
SELECT gen_random_uuid()::text, b."tenantId", b."productId", b."variantId", b."lotId", b."productName",
       b."variantLabel", b."lotNumber", b."bucketKind", 'OPENING', b."qty", b."qty",
       SUM(b."qty") OVER (PARTITION BY b."productId" ORDER BY b."ord", b."bucketId"),
       'PRODUCT', b."productId", NULL, 'Sistema',
       NOW() - (COUNT(*) OVER (PARTITION BY b."productId")
                - ROW_NUMBER() OVER (PARTITION BY b."productId" ORDER BY b."ord", b."bucketId")) * INTERVAL '1 millisecond'
  FROM (
    SELECT p."tenantId", p."id" AS "productId", NULL::text AS "variantId", NULL::text AS "lotId",
           p."name" AS "productName", NULL::text AS "variantLabel", NULL::text AS "lotNumber",
           'PRODUCT_UNTRACKED'::"StockMovementBucketKind" AS "bucketKind", 0 AS "ord", p."id" AS "bucketId",
           (p."quantity" - COALESCE((SELECT SUM(l."quantity") FROM "lots" l WHERE l."productId" = p."id"), 0))::int AS "qty"
      FROM "products" p
     WHERE p."hasVariants" = false
    UNION ALL
    SELECT l."tenantId", p."id", NULL, l."id", p."name", NULL, l."lotNumber",
           'LOT'::"StockMovementBucketKind", 1, l."id", l."quantity"
      FROM "lots" l JOIN "products" p ON p."id" = l."productId"
     WHERE p."hasVariants" = false
    UNION ALL
    SELECT v."tenantId", p."id", v."id", NULL, p."name", v."name", NULL,
           'VARIANT'::"StockMovementBucketKind", 2, v."id", v."quantity"
      FROM "variants" v JOIN "products" p ON p."id" = v."productId"
     WHERE p."hasVariants" = true
  ) b
 WHERE b."qty" <> 0;
