-- CreateEnum
CREATE TYPE "SaleItemDiscountType" AS ENUM ('amount', 'percentage');

-- AlterTable
ALTER TABLE "sale_items"
ADD COLUMN "discountType" "SaleItemDiscountType",
ADD COLUMN "discountValue" INTEGER,
ADD COLUMN "discountAmountCents" INTEGER,
ADD COLUMN "prePriceCentsBeforeDiscount" INTEGER,
ADD COLUMN "discountTitle" TEXT,
ADD COLUMN "discountedAt" TIMESTAMP(3);
