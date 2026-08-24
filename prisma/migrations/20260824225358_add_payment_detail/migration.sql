-- CreateTable
CREATE TABLE "payment_detail" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "beneficiary" TEXT NOT NULL,
    "clabe" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_detail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_detail_tenantId_idx" ON "payment_detail"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_detail_tenantId_clabe_key" ON "payment_detail"("tenantId", "clabe");

-- AddForeignKey
ALTER TABLE "payment_detail" ADD CONSTRAINT "payment_detail_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
