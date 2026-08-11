-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "UnitOfMeasure" ADD VALUE 'HORA';
ALTER TYPE "UnitOfMeasure" ADD VALUE 'SESION';
ALTER TYPE "UnitOfMeasure" ADD VALUE 'DIA';
ALTER TYPE "UnitOfMeasure" ADD VALUE 'CONSULTA';
ALTER TYPE "UnitOfMeasure" ADD VALUE 'CURSO';
ALTER TYPE "UnitOfMeasure" ADD VALUE 'PAQUETE';

-- CreateTable
CREATE TABLE "service_details" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "capacity" INTEGER,
    "notes" TEXT,

    CONSTRAINT "service_details_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_details_productId_key" ON "service_details"("productId");

-- AddForeignKey
ALTER TABLE "service_details" ADD CONSTRAINT "service_details_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
