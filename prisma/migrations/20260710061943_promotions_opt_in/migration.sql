-- CreateTable
CREATE TABLE "sale_promotion_opt_ins" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_promotion_opt_ins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sale_promotion_opt_ins_tenantId_idx" ON "sale_promotion_opt_ins"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "sale_promotion_opt_ins_saleId_promotionId_key" ON "sale_promotion_opt_ins"("saleId", "promotionId");

-- AddForeignKey
ALTER TABLE "sale_promotion_opt_ins" ADD CONSTRAINT "sale_promotion_opt_ins_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_promotion_opt_ins" ADD CONSTRAINT "sale_promotion_opt_ins_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_promotion_opt_ins" ADD CONSTRAINT "sale_promotion_opt_ins_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "promotions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
