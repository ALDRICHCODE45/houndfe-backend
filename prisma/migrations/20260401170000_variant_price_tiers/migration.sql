-- AlterTable
ALTER TABLE "variants"
ADD COLUMN "option" TEXT,
ADD COLUMN "value" TEXT;

-- CreateTable
CREATE TABLE "variant_tier_prices" (
    "id" TEXT NOT NULL,
    "variantPriceId" TEXT NOT NULL,
    "minQuantity" INTEGER NOT NULL,
    "priceCents" INTEGER NOT NULL,
    CONSTRAINT "variant_tier_prices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "variant_tier_prices_variantPriceId_minQuantity_key"
ON "variant_tier_prices"("variantPriceId", "minQuantity");

-- AddForeignKey
ALTER TABLE "variant_tier_prices"
ADD CONSTRAINT "variant_tier_prices_variantPriceId_fkey"
FOREIGN KEY ("variantPriceId") REFERENCES "variant_prices"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
