-- CreateEnum
-- Custom Payment Methods (custom-payment-methods / WU1) — D6.
-- Strict 4-value subset of SalePaymentMethod (no CREDIT — see design.md D6
-- and spec/payment-methods/spec.md "CREDIT is not a valid catalog category").
-- `SalePaymentMethod` and `sale_payments` are NOT modified (D11).
CREATE TYPE "PaymentMethodCategory" AS ENUM ('CASH', 'CARD_CREDIT', 'CARD_DEBIT', 'TRANSFER');

-- CreateTable
-- `payment_methods` is purely additive. No FK from `sale_payments` to this
-- row; the catalog identity rides on `SalePayment.metadataJson.catalog`
-- (opaque snapshot) so renaming / deactivating the catalog row NEVER
-- rewrites historical SalePayment rows (snapshot semantics — spec.md
-- "Snapshot Semantics for Historical SalePayments").
CREATE TABLE "payment_methods" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "PaymentMethodCategory" NOT NULL,
    "subtitle" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_methods_tenantId_idx" ON "payment_methods"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_methods_tenantId_name_key" ON "payment_methods"("tenantId", "name");

-- AddForeignKey
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Reverse path (documented for `prisma migrate diff --from-migrations`):
--   DROP TABLE "payment_methods";
--   DROP TYPE "PaymentMethodCategory";
-- No live FK from sale_payments to remove. `SalePaymentMethod` is untouched.