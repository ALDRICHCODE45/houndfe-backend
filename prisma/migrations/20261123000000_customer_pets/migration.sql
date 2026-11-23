-- customer-pets / T1 — several pets per customer (contract v1 §1, §4.1).
--
-- Additive only, hand-written (the shared test database is never diffed):
--   1. Five enums and the tenant-scoped table "customer_pets" (FK to the tenant
--      and to the customer, both ON DELETE CASCADE like "customer_addresses").
--   2. Indexes ("tenantId", "customerId", "status") for the per-customer lists
--      and the 20-active-pets count, and ("tenantId", "nameKey") for the POS
--      search. No uniqueness on names (owner decision D8).
--   3. CHECKs that mirror the write rules the service already enforces, so a
--      raw writer cannot store a state the API would refuse: version >= 1, the
--      "speciesOther" <-> OTHER pairing and the "birthDate" <-> precision pairing.
--   4. "sale_items": nullable "petId" (FK "customer_pets", ON DELETE SET NULL),
--      "petNameSnapshot" and "petSpeciesSnapshot". Every existing row gets NULL
--      in all three (metadata-only ADD COLUMN, no rewrite). The index on
--      "petId" serves the SET NULL cascade and the real-erasure scrub.
--
-- Locks: Prisma runs this file in ONE transaction. ADD COLUMN takes a brief
-- ACCESS EXCLUSIVE lock on "sale_items" and the FK a SHARE ROW EXCLUSIVE lock
-- on "customer_pets" (new, empty). The FK validation scans "sale_items" once
-- (every "petId" is NULL), and the index build blocks writes on "sale_items"
-- for its duration; run at low traffic.
--
-- Rollback (manual, only while no pet exists or after exporting them):
--   DROP INDEX "sale_items_petId_idx";
--   ALTER TABLE "sale_items"
--     DROP CONSTRAINT "sale_items_petId_fkey",
--     DROP COLUMN "petSpeciesSnapshot",
--     DROP COLUMN "petNameSnapshot",
--     DROP COLUMN "petId";
--   DROP TABLE "customer_pets";
--   DROP TYPE "CustomerPetCreatedVia";
--   DROP TYPE "CustomerPetStatus";
--   DROP TYPE "CustomerPetBirthDatePrecision";
--   DROP TYPE "CustomerPetSize";
--   DROP TYPE "CustomerPetSpecies";

-- CreateEnum
CREATE TYPE "CustomerPetSpecies" AS ENUM ('DOG', 'CAT', 'OTHER');

-- CreateEnum
CREATE TYPE "CustomerPetSize" AS ENUM ('SMALL', 'MEDIUM', 'LARGE', 'GIANT');

-- CreateEnum
CREATE TYPE "CustomerPetBirthDatePrecision" AS ENUM ('EXACT', 'MONTH', 'YEAR');

-- CreateEnum
CREATE TYPE "CustomerPetStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CustomerPetCreatedVia" AS ENUM ('POS', 'CHATBOT');

-- AlterTable
ALTER TABLE "sale_items" ADD COLUMN     "petId" TEXT,
ADD COLUMN     "petNameSnapshot" TEXT,
ADD COLUMN     "petSpeciesSnapshot" "CustomerPetSpecies";

-- CreateTable
CREATE TABLE "customer_pets" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "nameKey" VARCHAR(60) NOT NULL,
    "species" "CustomerPetSpecies" NOT NULL,
    "speciesOther" VARCHAR(40),
    "breed" VARCHAR(80),
    "size" "CustomerPetSize",
    "birthDate" DATE,
    "birthDatePrecision" "CustomerPetBirthDatePrecision",
    "allergies" VARCHAR(500),
    "notes" VARCHAR(500),
    "status" "CustomerPetStatus" NOT NULL DEFAULT 'ACTIVE',
    "archivedAt" TIMESTAMP(3),
    "archivedReason" VARCHAR(280),
    "createdVia" "CustomerPetCreatedVia" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_pets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "customer_pets_version_chk" CHECK ("version" >= 1),
    CONSTRAINT "customer_pets_species_other_chk" CHECK (
        ("species" = 'OTHER' AND "speciesOther" IS NOT NULL)
        OR ("species" <> 'OTHER' AND "speciesOther" IS NULL)
    ),
    CONSTRAINT "customer_pets_birth_precision_chk" CHECK (
        ("birthDate" IS NULL AND "birthDatePrecision" IS NULL)
        OR ("birthDate" IS NOT NULL AND "birthDatePrecision" IS NOT NULL)
    )
);

-- CreateIndex
CREATE INDEX "customer_pets_tenantId_customerId_status_idx" ON "customer_pets"("tenantId", "customerId", "status");

-- CreateIndex
CREATE INDEX "customer_pets_tenantId_nameKey_idx" ON "customer_pets"("tenantId", "nameKey");

-- CreateIndex
CREATE INDEX "sale_items_petId_idx" ON "sale_items"("petId");

-- AddForeignKey
ALTER TABLE "customer_pets" ADD CONSTRAINT "customer_pets_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_pets" ADD CONSTRAINT "customer_pets_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_petId_fkey" FOREIGN KEY ("petId") REFERENCES "customer_pets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
