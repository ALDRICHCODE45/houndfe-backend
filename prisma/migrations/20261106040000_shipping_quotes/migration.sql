-- shipping-zones / T3 (S6-S9): persisted, expiring shipping quotes. Additive only.

-- CreateTable
CREATE TABLE "shipping_quotes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "customerId" TEXT,
    "phoneCountryCode" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "lines" JSONB NOT NULL,
    "destination" JSONB NOT NULL,
    "shippingAddressId" TEXT,
    "zoneType" "DeliveryZoneType" NOT NULL,
    "zone" JSONB NOT NULL,
    "carrier" TEXT,
    "service" TEXT,
    "carrierRateId" TEXT,
    "etaDays" INTEGER,
    "etaReason" TEXT,
    "box" JSONB,
    "costCents" INTEGER NOT NULL,
    "creditCents" INTEGER NOT NULL,
    "customerChargeCents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'MXN',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipping_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shipping_quotes_tokenHash_key" ON "shipping_quotes"("tokenHash");

-- CreateIndex
CREATE INDEX "shipping_quotes_tenantId_createdAt_idx" ON "shipping_quotes"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "shipping_quotes" ADD CONSTRAINT "shipping_quotes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Defense in depth (Prisma does not model CHECK constraints).
-- Money: credit never exceeds the cost and the charge is exactly cost - credit.
ALTER TABLE "shipping_quotes" ADD CONSTRAINT "shipping_quotes_money_chk" CHECK (
    "costCents" >= 0 AND "creditCents" >= 0 AND "creditCents" <= "costCents"
    AND "customerChargeCents" = "costCents" - "creditCents"
    AND "currency" = 'MXN'
);
-- Only deliverable zones produce a quote; a carrier option exists only for
-- CARRIER_ONLY, and STOCK_PENDING withholds the days.
ALTER TABLE "shipping_quotes" ADD CONSTRAINT "shipping_quotes_shape_chk" CHECK (
    "zoneType" IN ('FREE', 'SURCHARGE', 'CARRIER_ONLY')
    AND (("zoneType" = 'CARRIER_ONLY') = ("carrier" IS NOT NULL AND "service" IS NOT NULL AND "box" IS NOT NULL))
    AND ("zoneType" <> 'FREE' OR "costCents" = 0)
    AND ("etaReason" IS NULL OR ("etaReason" = 'STOCK_PENDING' AND "etaDays" IS NULL))
    AND ("etaDays" IS NULL OR "etaDays" >= 0)
    AND "expiresAt" > "createdAt"
);
