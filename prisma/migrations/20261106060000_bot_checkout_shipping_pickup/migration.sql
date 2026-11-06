-- shipping-zones / T7 (S8, S10): bot checkout shipping by verified quote or
-- store pickup, and sucursal opening hours. Additive only.

-- CreateEnum
CREATE TYPE "SaleFulfillmentMode" AS ENUM ('DELIVERY', 'PICKUP');

-- AlterTable
ALTER TABLE "sales" ADD COLUMN     "fulfillmentMode" "SaleFulfillmentMode",
ADD COLUMN     "shippingQuoteRecordId" TEXT;

-- CreateTable
CREATE TABLE "tenant_opening_hours" (
    "tenantId" TEXT NOT NULL,
    "timeZone" TEXT NOT NULL,
    "days" JSONB NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_opening_hours_pkey" PRIMARY KEY ("tenantId")
);

-- CreateIndex
-- One quote backs at most one sale (single use, enforced by the database).
CREATE UNIQUE INDEX "sales_shippingQuoteRecordId_key" ON "sales"("shippingQuoteRecordId");

-- AddForeignKey
-- NO ACTION (checked at statement end) lets a tenant delete cascade to both
-- sales and shipping_quotes, while a lone quote delete cannot orphan a sale.
ALTER TABLE "sales" ADD CONSTRAINT "sales_shippingQuoteRecordId_fkey" FOREIGN KEY ("shippingQuoteRecordId") REFERENCES "shipping_quotes"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tenant_opening_hours" ADD CONSTRAINT "tenant_opening_hours_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Defense in depth (Prisma does not model CHECK constraints): a quote-backed
-- sale is a delivery, and a pickup sale charges no shipping.
ALTER TABLE "sales" ADD CONSTRAINT "sales_fulfillment_shipping_chk" CHECK (
    ("shippingQuoteRecordId" IS NULL OR "fulfillmentMode" = 'DELIVERY')
    AND ("fulfillmentMode" IS DISTINCT FROM 'PICKUP' OR "shippingChargeCents" = 0)
);
-- The week is a JSON array of exactly seven days (validated by the service).
ALTER TABLE "tenant_opening_hours" ADD CONSTRAINT "tenant_opening_hours_days_chk" CHECK (
    jsonb_typeof("days") = 'array' AND jsonb_array_length("days") = 7
);
