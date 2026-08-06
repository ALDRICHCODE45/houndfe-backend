-- CreateEnum
CREATE TYPE "QuotationStatus" AS ENUM ('DRAFT', 'SENT', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "QuotationCancelReason" AS ENUM ('CUSTOMER_REQUEST', 'PRICE_OBJECTION', 'EXPIRED', 'OTHER');

-- CreateEnum
CREATE TYPE "QuotationItemPriceSource" AS ENUM ('PRICE_LIST', 'CUSTOM');

-- CreateEnum
CREATE TYPE "QuotationItemDiscountType" AS ENUM ('amount', 'percentage');

-- CreateTable
CREATE TABLE "quotations" (
    "id" TEXT NOT NULL,
    "sellerUserId" TEXT NOT NULL,
    "customerId" TEXT,
    "globalPriceListId" TEXT,
    "priceListExplicitlySet" BOOLEAN NOT NULL DEFAULT false,
    "status" "QuotationStatus" NOT NULL DEFAULT 'DRAFT',
    "expiresAt" TIMESTAMP(3),
    "cancelReason" "QuotationCancelReason",
    "canceledAt" TIMESTAMP(3),
    "subtotalCents" INTEGER NOT NULL DEFAULT 0,
    "discountCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL DEFAULT 0,
    "manuallyEnded" BOOLEAN NOT NULL DEFAULT false,
    "tenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotation_items" (
    "id" TEXT NOT NULL,
    "quotationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "productName" TEXT NOT NULL,
    "variantName" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitPriceCents" INTEGER NOT NULL,
    "unitPriceCurrency" TEXT NOT NULL DEFAULT 'MXN',
    "priceSource" "QuotationItemPriceSource",
    "appliedPriceListId" TEXT,
    "customPriceCents" INTEGER,
    "discountType" "QuotationItemDiscountType",
    "discountValue" INTEGER,
    "discountAmountCents" INTEGER NOT NULL DEFAULT 0,
    "promotionId" TEXT,
    "tenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quotation_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotation_promotion_vetoes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "quotationId" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quotation_promotion_vetoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotation_promotion_opt_ins" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "quotationId" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quotation_promotion_opt_ins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quotations_tenantId_idx" ON "quotations"("tenantId");

-- CreateIndex
CREATE INDEX "quotations_tenantId_status_idx" ON "quotations"("tenantId", "status");

-- CreateIndex
CREATE INDEX "quotations_tenantId_createdAt_idx" ON "quotations"("tenantId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "quotations_sellerUserId_idx" ON "quotations"("sellerUserId");

-- CreateIndex
CREATE INDEX "quotations_customerId_idx" ON "quotations"("customerId");

-- CreateIndex
CREATE INDEX "quotations_expiresAt_idx" ON "quotations"("expiresAt");

-- CreateIndex
CREATE INDEX "quotation_items_quotationId_idx" ON "quotation_items"("quotationId");

-- CreateIndex
CREATE INDEX "quotation_items_tenantId_idx" ON "quotation_items"("tenantId");

-- CreateIndex
CREATE INDEX "quotation_items_promotionId_idx" ON "quotation_items"("promotionId");

-- CreateIndex
CREATE INDEX "quotation_promotion_vetoes_tenantId_idx" ON "quotation_promotion_vetoes"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "quotation_promotion_vetoes_quotationId_promotionId_key" ON "quotation_promotion_vetoes"("quotationId", "promotionId");

-- CreateIndex
CREATE INDEX "quotation_promotion_opt_ins_tenantId_idx" ON "quotation_promotion_opt_ins"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "quotation_promotion_opt_ins_quotationId_promotionId_key" ON "quotation_promotion_opt_ins"("quotationId", "promotionId");

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_sellerUserId_fkey" FOREIGN KEY ("sellerUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_globalPriceListId_fkey" FOREIGN KEY ("globalPriceListId") REFERENCES "global_price_lists"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_items" ADD CONSTRAINT "quotation_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_items" ADD CONSTRAINT "quotation_items_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "quotations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_items" ADD CONSTRAINT "quotation_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_items" ADD CONSTRAINT "quotation_items_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_items" ADD CONSTRAINT "quotation_items_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "promotions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_promotion_vetoes" ADD CONSTRAINT "quotation_promotion_vetoes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_promotion_vetoes" ADD CONSTRAINT "quotation_promotion_vetoes_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "quotations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_promotion_vetoes" ADD CONSTRAINT "quotation_promotion_vetoes_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "promotions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_promotion_opt_ins" ADD CONSTRAINT "quotation_promotion_opt_ins_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_promotion_opt_ins" ADD CONSTRAINT "quotation_promotion_opt_ins_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "quotations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_promotion_opt_ins" ADD CONSTRAINT "quotation_promotion_opt_ins_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "promotions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
