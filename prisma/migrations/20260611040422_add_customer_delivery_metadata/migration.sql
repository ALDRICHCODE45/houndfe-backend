-- AlterTable
ALTER TABLE "customer_addresses" ADD COLUMN     "carrierPhone" TEXT,
ADD COLUMN     "label" TEXT,
ADD COLUMN     "visualReferences" TEXT;

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "preferredPaymentMethod" TEXT;

-- CreateIndex
CREATE INDEX "customers_tenantId_phoneCountryCode_phone_idx" ON "customers"("tenantId", "phoneCountryCode", "phone");
