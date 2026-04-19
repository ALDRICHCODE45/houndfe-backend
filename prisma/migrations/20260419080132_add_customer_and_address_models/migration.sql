-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT,
    "phoneCountryCode" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "comments" TEXT,
    "globalPriceListId" TEXT,
    "businessName" TEXT,
    "fiscalZipCode" TEXT,
    "rfc" TEXT,
    "fiscalRegime" TEXT,
    "billingStreet" TEXT,
    "billingExteriorNumber" TEXT,
    "billingInteriorNumber" TEXT,
    "billingZipCode" TEXT,
    "billingNeighborhood" TEXT,
    "billingMunicipality" TEXT,
    "billingCity" TEXT,
    "billingState" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_addresses" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "street" TEXT NOT NULL,
    "exteriorNumber" TEXT,
    "interiorNumber" TEXT,
    "zipCode" TEXT,
    "neighborhood" TEXT,
    "municipality" TEXT,
    "city" TEXT,
    "state" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_addresses_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_globalPriceListId_fkey" FOREIGN KEY ("globalPriceListId") REFERENCES "global_price_lists"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
