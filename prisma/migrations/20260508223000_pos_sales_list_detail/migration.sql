-- CreateEnum
CREATE TYPE "SaleChannel" AS ENUM ('POS', 'ONLINE');

-- CreateEnum
CREATE TYPE "SaleDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'NOT_APPLICABLE');

-- AlterTable
ALTER TABLE "sales"
ADD COLUMN "channel" "SaleChannel" NOT NULL DEFAULT 'POS',
ADD COLUMN "customerId" TEXT,
ADD COLUMN "deliveryStatus" "SaleDeliveryStatus" NOT NULL DEFAULT 'DELIVERED',
ADD COLUMN "register" TEXT NOT NULL DEFAULT 'Principal',
ADD COLUMN "sellerUserId" TEXT;

-- AlterTable
ALTER TABLE "sale_items"
ADD COLUMN "imageUrl" TEXT;

-- CreateIndex
CREATE INDEX "sales_sellerUserId_idx" ON "sales"("sellerUserId");

-- CreateIndex
CREATE INDEX "sales_customerId_idx" ON "sales"("customerId");

-- AddForeignKey
ALTER TABLE "sales"
ADD CONSTRAINT "sales_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales"
ADD CONSTRAINT "sales_sellerUserId_fkey" FOREIGN KEY ("sellerUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
