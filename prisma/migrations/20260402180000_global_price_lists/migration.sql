-- CreateTable
CREATE TABLE "global_price_lists" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "global_price_lists_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "global_price_lists_name_key" ON "global_price_lists"("name");

-- Seed existing list names (for dev DBs with prior rows)
INSERT INTO "global_price_lists" ("id", "name", "isDefault", "createdAt", "updatedAt")
SELECT DISTINCT
  md5(pl."name"),
  pl."name",
  CASE WHEN pl."name" = 'PUBLICO' THEN true ELSE false END,
  NOW(),
  NOW()
FROM "price_lists" pl;

-- Ensure PUBLICO exists as default (for fresh DBs)
INSERT INTO "global_price_lists" ("id", "name", "isDefault", "createdAt", "updatedAt")
SELECT md5('PUBLICO'), 'PUBLICO', true, NOW(), NOW()
WHERE NOT EXISTS (
  SELECT 1
  FROM "global_price_lists"
  WHERE "name" = 'PUBLICO'
);

-- AlterTable
ALTER TABLE "price_lists" ADD COLUMN "globalPriceListId" TEXT;

-- Backfill FK on existing rows using prior name
UPDATE "price_lists" pl
SET "globalPriceListId" = gpl."id"
FROM "global_price_lists" gpl
WHERE gpl."name" = pl."name";

-- AlterTable
ALTER TABLE "price_lists" ALTER COLUMN "globalPriceListId" SET NOT NULL;

-- DropIndex
DROP INDEX "price_lists_productId_name_key";

-- CreateIndex
CREATE UNIQUE INDEX "price_lists_productId_globalPriceListId_key" ON "price_lists"("productId", "globalPriceListId");

-- AddForeignKey
ALTER TABLE "price_lists"
ADD CONSTRAINT "price_lists_globalPriceListId_fkey"
FOREIGN KEY ("globalPriceListId") REFERENCES "global_price_lists"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "price_lists" DROP COLUMN "name";
