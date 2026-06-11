-- CreateEnum
CREATE TYPE "ReceiptEvidenceStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED');

-- AlterEnum
ALTER TYPE "SaleDeliveryStatus" ADD VALUE 'SHIPPED';

-- AlterTable
ALTER TABLE "sales" ADD COLUMN     "carrierName" TEXT,
ADD COLUMN     "estimatedDeliveryAt" TIMESTAMP(3),
ADD COLUMN     "trackingRef" TEXT;

-- CreateTable
CREATE TABLE "receipt_evidences" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "mediaUrl" TEXT NOT NULL,
    "declaredAmountCents" INTEGER NOT NULL,
    "declaredDate" TIMESTAMP(3),
    "declaredReference" TEXT,
    "status" "ReceiptEvidenceStatus" NOT NULL DEFAULT 'PENDING',
    "confirmedByUserId" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_evidences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "receipt_evidences_tenantId_saleId_idx" ON "receipt_evidences"("tenantId", "saleId");

-- AddForeignKey
ALTER TABLE "receipt_evidences" ADD CONSTRAINT "receipt_evidences_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_evidences" ADD CONSTRAINT "receipt_evidences_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
