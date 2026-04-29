-- CreateEnum
CREATE TYPE "SaleItemPriceSource" AS ENUM ('DEFAULT', 'PRICE_LIST', 'CUSTOM');

-- AlterTable
ALTER TABLE "sale_items" ADD COLUMN     "appliedPriceListId" TEXT,
ADD COLUMN     "customPriceCents" INTEGER,
ADD COLUMN     "originalPriceCents" INTEGER,
ADD COLUMN     "priceSource" "SaleItemPriceSource";
