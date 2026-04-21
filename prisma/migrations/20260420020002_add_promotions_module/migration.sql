-- CreateEnum
CREATE TYPE "PromotionType" AS ENUM ('PRODUCT_DISCOUNT', 'ORDER_DISCOUNT', 'BUY_X_GET_Y', 'ADVANCED');

-- CreateEnum
CREATE TYPE "PromotionMethod" AS ENUM ('AUTOMATIC', 'MANUAL');

-- CreateEnum
CREATE TYPE "PromotionStatus" AS ENUM ('ACTIVE', 'SCHEDULED', 'ENDED');

-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('PERCENTAGE', 'FIXED');

-- CreateEnum
CREATE TYPE "PromotionTargetType" AS ENUM ('CATEGORIES', 'BRANDS', 'PRODUCTS');

-- CreateEnum
CREATE TYPE "CustomerScope" AS ENUM ('ALL', 'REGISTERED_ONLY', 'SPECIFIC');

-- CreateEnum
CREATE TYPE "DayOfWeek" AS ENUM ('MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY');

-- CreateEnum
CREATE TYPE "TargetSide" AS ENUM ('DEFAULT', 'BUY', 'GET');

-- CreateTable
CREATE TABLE "promotions" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" "PromotionType" NOT NULL,
    "method" "PromotionMethod" NOT NULL,
    "status" "PromotionStatus" NOT NULL DEFAULT 'ACTIVE',
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "customerScope" "CustomerScope" NOT NULL DEFAULT 'ALL',
    "discountType" "DiscountType",
    "discountValue" INTEGER,
    "minPurchaseAmountCents" INTEGER,
    "appliesTo" "PromotionTargetType",
    "buyQuantity" INTEGER,
    "getQuantity" INTEGER,
    "getDiscountPercent" INTEGER,
    "buyTargetType" "PromotionTargetType",
    "getTargetType" "PromotionTargetType",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "promotions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion_target_items" (
    "id" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "side" "TargetSide" NOT NULL DEFAULT 'DEFAULT',
    "targetType" "PromotionTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,

    CONSTRAINT "promotion_target_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion_customers" (
    "id" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,

    CONSTRAINT "promotion_customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion_price_lists" (
    "id" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "globalPriceListId" TEXT NOT NULL,

    CONSTRAINT "promotion_price_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion_days_of_week" (
    "id" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "day" "DayOfWeek" NOT NULL,

    CONSTRAINT "promotion_days_of_week_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "promotions_type_idx" ON "promotions"("type");

-- CreateIndex
CREATE INDEX "promotions_method_idx" ON "promotions"("method");

-- CreateIndex
CREATE INDEX "promotions_status_startDate_endDate_idx" ON "promotions"("status", "startDate", "endDate");

-- CreateIndex
CREATE INDEX "promotion_target_items_targetType_targetId_idx" ON "promotion_target_items"("targetType", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_target_items_promotionId_side_targetType_targetId_key" ON "promotion_target_items"("promotionId", "side", "targetType", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_customers_promotionId_customerId_key" ON "promotion_customers"("promotionId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_price_lists_promotionId_globalPriceListId_key" ON "promotion_price_lists"("promotionId", "globalPriceListId");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_days_of_week_promotionId_day_key" ON "promotion_days_of_week"("promotionId", "day");

-- AddForeignKey
ALTER TABLE "promotion_target_items" ADD CONSTRAINT "promotion_target_items_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "promotions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_customers" ADD CONSTRAINT "promotion_customers_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "promotions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_customers" ADD CONSTRAINT "promotion_customers_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_price_lists" ADD CONSTRAINT "promotion_price_lists_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "promotions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_price_lists" ADD CONSTRAINT "promotion_price_lists_globalPriceListId_fkey" FOREIGN KEY ("globalPriceListId") REFERENCES "global_price_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_days_of_week" ADD CONSTRAINT "promotion_days_of_week_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "promotions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
