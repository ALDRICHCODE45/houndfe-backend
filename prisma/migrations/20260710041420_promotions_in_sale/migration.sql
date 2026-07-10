-- AlterTable
ALTER TABLE "sale_items" ADD COLUMN     "promotionId" TEXT;

-- CreateTable
CREATE TABLE "sale_promotion_applied" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "promotionId" TEXT,
    "discountType" "SaleItemDiscountType",
    "discountValue" INTEGER,
    "discountAmountCents" INTEGER NOT NULL,
    "discountTitle" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sale_promotion_applied_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_promotion_vetoes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_promotion_vetoes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sale_promotion_applied_tenantId_idx" ON "sale_promotion_applied"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "sale_promotion_applied_saleId_key" ON "sale_promotion_applied"("saleId");

-- CreateIndex
CREATE INDEX "sale_promotion_vetoes_tenantId_idx" ON "sale_promotion_vetoes"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "sale_promotion_vetoes_saleId_promotionId_key" ON "sale_promotion_vetoes"("saleId", "promotionId");

-- CreateIndex
CREATE INDEX "sale_items_promotionId_idx" ON "sale_items"("promotionId");

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "promotions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_promotion_applied" ADD CONSTRAINT "sale_promotion_applied_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_promotion_applied" ADD CONSTRAINT "sale_promotion_applied_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_promotion_applied" ADD CONSTRAINT "sale_promotion_applied_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "promotions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_promotion_vetoes" ADD CONSTRAINT "sale_promotion_vetoes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_promotion_vetoes" ADD CONSTRAINT "sale_promotion_vetoes_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_promotion_vetoes" ADD CONSTRAINT "sale_promotion_vetoes_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "promotions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
