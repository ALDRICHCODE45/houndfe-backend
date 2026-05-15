-- AlterTable
ALTER TABLE "sales" ADD COLUMN     "shippingAddressId" TEXT;

-- CreateIndex
CREATE INDEX "sales_shippingAddressId_idx" ON "sales"("shippingAddressId");

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_shippingAddressId_fkey" FOREIGN KEY ("shippingAddressId") REFERENCES "customer_addresses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
