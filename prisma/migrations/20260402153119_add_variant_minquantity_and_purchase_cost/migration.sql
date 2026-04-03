-- AlterTable
ALTER TABLE "variants" ADD COLUMN     "minQuantity" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "purchaseNetCostCents" INTEGER;
