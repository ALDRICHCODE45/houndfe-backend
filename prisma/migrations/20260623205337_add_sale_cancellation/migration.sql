-- CreateEnum
CREATE TYPE "SaleCancelReason" AS ENUM ('CUSTOMER_REQUEST', 'ORDER_ERROR', 'OUT_OF_STOCK', 'DUPLICATE_SALE', 'OTHER');

-- AlterEnum
ALTER TYPE "SaleStatus" ADD VALUE 'CANCELED';

-- AlterTable
ALTER TABLE "sales" ADD COLUMN     "cancelReason" "SaleCancelReason",
ADD COLUMN     "canceledAt" TIMESTAMP(3),
ADD COLUMN     "canceledByUserId" TEXT;

-- CreateTable
CREATE TABLE "sale_refunds" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "salePaymentId" TEXT,
    "method" "SalePaymentMethod" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "reason" "SaleCancelReason" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_refunds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sale_refunds_tenantId_saleId_idx" ON "sale_refunds"("tenantId", "saleId");

-- CreateIndex
CREATE INDEX "sale_refunds_tenantId_createdAt_idx" ON "sale_refunds"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "sale_refunds" ADD CONSTRAINT "sale_refunds_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_refunds" ADD CONSTRAINT "sale_refunds_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_refunds" ADD CONSTRAINT "sale_refunds_salePaymentId_fkey" FOREIGN KEY ("salePaymentId") REFERENCES "sale_payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
