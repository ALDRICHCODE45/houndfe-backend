-- CreateEnum
CREATE TYPE "SatInclusion" AS ENUM ('REQUIRED', 'NONE', 'OPTIONAL');

-- CreateTable
CREATE TABLE "sat_product_service_keys" (
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "searchText" TEXT NOT NULL,
    "includeIva" "SatInclusion" NOT NULL DEFAULT 'NONE',
    "includeIeps" "SatInclusion" NOT NULL DEFAULT 'NONE',
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3),

    CONSTRAINT "sat_product_service_keys_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "sat_product_service_keys_searchText_idx" ON "sat_product_service_keys"("searchText");