-- AlterEnum
ALTER TYPE "SaleStatus" ADD VALUE 'CONFIRMED';

-- CreateEnum
CREATE TYPE "SalePaymentMethod" AS ENUM ('CASH', 'CARD_CREDIT', 'CARD_DEBIT', 'TRANSFER', 'CREDIT');

-- CreateEnum
CREATE TYPE "SalePaymentStatus" AS ENUM ('PAID', 'PARTIAL', 'CREDIT');

-- CreateEnum
CREATE TYPE "SaleIdempotencyStatus" AS ENUM ('IN_FLIGHT', 'SUCCEEDED', 'FAILED');

-- AlterTable
ALTER TABLE "sales"
ADD COLUMN "subtotalCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "discountCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "totalCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "paidCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "debtCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "changeDueCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "paymentStatus" "SalePaymentStatus",
ADD COLUMN "confirmedAt" TIMESTAMP(3),
ADD COLUMN "folio" TEXT;

-- CreateTable
CREATE TABLE "sale_payments" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "method" "SalePaymentMethod" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "metadataJson" JSONB,
    "tenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_idempotency" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" "SaleIdempotencyStatus" NOT NULL,
    "responseJson" JSONB,
    "saleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sale_idempotency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_folio_counters" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sale_folio_counters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sale_payments_saleId_idx" ON "sale_payments"("saleId");

-- CreateIndex
CREATE INDEX "sale_payments_tenantId_idx" ON "sale_payments"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "sale_idempotency_tenantId_operation_key_key" ON "sale_idempotency"("tenantId", "operation", "key");

-- CreateIndex
CREATE INDEX "sale_idempotency_tenantId_idx" ON "sale_idempotency"("tenantId");

-- CreateIndex
CREATE INDEX "sale_idempotency_saleId_idx" ON "sale_idempotency"("saleId");

-- CreateIndex
CREATE UNIQUE INDEX "sale_folio_counters_tenantId_period_key" ON "sale_folio_counters"("tenantId", "period");

-- CreateIndex
CREATE INDEX "sale_folio_counters_tenantId_idx" ON "sale_folio_counters"("tenantId");

-- AddForeignKey
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_idempotency" ADD CONSTRAINT "sale_idempotency_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_idempotency" ADD CONSTRAINT "sale_idempotency_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sales"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_folio_counters" ADD CONSTRAINT "sale_folio_counters_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
