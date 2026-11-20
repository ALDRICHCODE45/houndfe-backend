-- restock-backorder / T1 — backorders (contract v1 §1, §6): the «pedido por
-- reposición» model, its per-tenant folio counter and the database
-- guarantees the later tasks rely on (T2 reserve/allocate, T3 checkout,
-- T4 overdue ETA, T5 staff API).
--
-- Additive only, hand-written: two new enums, two new tables and their
-- indexes/constraints. No existing table, column, index or constraint is
-- altered, and there is no backfill.
--
-- Tenant safety: every row carries "tenantId" (FK to tenants, ON DELETE
-- CASCADE). The product, chatbot request and sale links are tenant-qualified
-- composite FKs onto the existing ("tenantId", "id") unique indexes, so
-- PostgreSQL rejects a cross-tenant link. customers, variants and
-- human_decisions have no ("tenantId", "id") unique index (and are not
-- altered here), so those three links are plain "id" FKs like
-- chatbot_requests/sale_items; the service resolves them with the tenant
-- filter first. Every business FK is ON DELETE RESTRICT (a backorder is
-- history); only the optional cancelling user is SET NULL.
--
-- The one-active-backorder rule is a PARTIAL unique index over
-- ("tenantId", "customerId", "productId", COALESCE("variantId", '')) WHERE
-- status IN ('WAITING','RESERVED'): COALESCE makes NULL variants compare equal
-- (a plain unique index would treat every NULL as distinct), and ids are UUID
-- text so '' can never collide with a real variant. Prisma's DSL cannot
-- express it, so this file is its only definition.
--
-- Rollback (manual, only while no backorder exists):
--   DROP TABLE "backorders";
--   DROP TABLE "backorder_folio_counters";
--   DROP TYPE "BackorderCancelledByKind";
--   DROP TYPE "BackorderStatus";

-- CreateEnum
CREATE TYPE "BackorderStatus" AS ENUM ('WAITING', 'RESERVED', 'CONFIRMED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BackorderCancelledByKind" AS ENUM ('STAFF', 'CUSTOMER');

-- CreateTable
CREATE TABLE "backorder_folio_counters" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "backorder_folio_counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backorders" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "folio" TEXT NOT NULL,
    "status" "BackorderStatus" NOT NULL DEFAULT 'WAITING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "customerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "quantity" INTEGER NOT NULL,
    "referencePriceCents" INTEGER NOT NULL,
    "referencePriceListId" TEXT,
    "currentPriceCents" INTEGER,
    "finalPriceCents" INTEGER,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "estimatedArrivalDays" INTEGER NOT NULL,
    "estimatedAt" TIMESTAMP(3) NOT NULL,
    "sourceDecisionId" TEXT NOT NULL,
    "chatbotRequestId" TEXT,
    "reservedAt" TIMESTAMP(3),
    "reservedUntil" TIMESTAMP(3),
    "reminderAt" TIMESTAMP(3),
    "reservationStage" SMALLINT NOT NULL DEFAULT 0,
    "etaStage" SMALLINT NOT NULL DEFAULT 0,
    "passedOverCount" INTEGER NOT NULL DEFAULT 0,
    "reestimateDecisionId" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "saleId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" VARCHAR(280),
    "cancelledByKind" "BackorderCancelledByKind",
    "cancelledByUserId" TEXT,
    "expiredAt" TIMESTAMP(3),
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "backorders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "backorder_folio_counters_tenantId_key" ON "backorder_folio_counters"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "backorders_tenantId_id_key" ON "backorders"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "backorders_tenantId_folio_key" ON "backorders"("tenantId", "folio");

-- CreateIndex
CREATE UNIQUE INDEX "backorders_tenantId_idempotencyKey_key" ON "backorders"("tenantId", "idempotencyKey");

-- CreateIndex: FIFO queue walk of one product/variant (allocator, queuePosition).
CREATE INDEX "backorders_queue_idx" ON "backorders"("tenantId", "productId", "variantId", "status", "scheduledAt", "id");

-- CreateIndex
CREATE INDEX "backorders_tenantId_customerId_status_idx" ON "backorders"("tenantId", "customerId", "status");

-- CreateIndex
CREATE INDEX "backorders_tenantId_updatedAt_idx" ON "backorders"("tenantId", "updatedAt");

-- CreateIndex
CREATE INDEX "backorders_customerId_idx" ON "backorders"("customerId");

-- CreateIndex
CREATE INDEX "backorders_reestimateDecisionId_idx" ON "backorders"("reestimateDecisionId");

-- One ACTIVE backorder per customer + product + variant (NULL variants equal).
CREATE UNIQUE INDEX "backorders_one_active_per_customer_product_variant_uq"
    ON "backorders"("tenantId", "customerId", "productId", (COALESCE("variantId", '')))
    WHERE "status" IN ('WAITING', 'RESERVED');

-- AddForeignKey
ALTER TABLE "backorder_folio_counters" ADD CONSTRAINT "backorder_folio_counters_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backorders" ADD CONSTRAINT "backorders_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (tenant-qualified)
ALTER TABLE "backorders" ADD CONSTRAINT "backorders_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backorders" ADD CONSTRAINT "backorders_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backorders" ADD CONSTRAINT "backorders_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backorders" ADD CONSTRAINT "backorders_sourceDecisionId_fkey" FOREIGN KEY ("sourceDecisionId") REFERENCES "human_decisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backorders" ADD CONSTRAINT "backorders_reestimateDecisionId_fkey" FOREIGN KEY ("reestimateDecisionId") REFERENCES "human_decisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (tenant-qualified; MATCH SIMPLE skips the check while chatbotRequestId is NULL)
ALTER TABLE "backorders" ADD CONSTRAINT "backorders_tenantId_chatbotRequestId_fkey" FOREIGN KEY ("tenantId", "chatbotRequestId") REFERENCES "chatbot_requests"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (tenant-qualified; MATCH SIMPLE skips the check while saleId is NULL)
ALTER TABLE "backorders" ADD CONSTRAINT "backorders_tenantId_saleId_fkey" FOREIGN KEY ("tenantId", "saleId") REFERENCES "sales"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backorders" ADD CONSTRAINT "backorders_cancelledByUserId_fkey" FOREIGN KEY ("cancelledByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Shape and range guarantees (folio BO-000001, wider numbers are not truncated).
ALTER TABLE "backorders" ADD CONSTRAINT "backorders_folio_format"
    CHECK ("folio" ~ '^BO-[0-9]{6,}$');

ALTER TABLE "backorders" ADD CONSTRAINT "backorders_idempotency_shape"
    CHECK (char_length("idempotencyKey") BETWEEN 1 AND 200 AND "requestHash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "backorders" ADD CONSTRAINT "backorders_quantity_positive"
    CHECK ("quantity" >= 1);

ALTER TABLE "backorders" ADD CONSTRAINT "backorders_version_positive"
    CHECK ("version" >= 1);

ALTER TABLE "backorders" ADD CONSTRAINT "backorders_prices_non_negative"
    CHECK (
        "referencePriceCents" >= 0
        AND ("currentPriceCents" IS NULL OR "currentPriceCents" >= 0)
        AND ("finalPriceCents" IS NULL OR "finalPriceCents" >= 0)
    );

-- finalPriceCents = min(referencePriceCents, currentPriceCents) (owner D1).
ALTER TABLE "backorders" ADD CONSTRAINT "backorders_final_price_not_above_reference"
    CHECK ("finalPriceCents" IS NULL OR "finalPriceCents" <= "referencePriceCents");

-- Same range as the RESTOCK decision's restockDays CHECK.
ALTER TABLE "backorders" ADD CONSTRAINT "backorders_estimated_days_range"
    CHECK ("estimatedArrivalDays" BETWEEN 1 AND 365);

ALTER TABLE "backorders" ADD CONSTRAINT "backorders_stage_range"
    CHECK ("reservationStage" BETWEEN 0 AND 2 AND "etaStage" BETWEEN 0 AND 2);

ALTER TABLE "backorders" ADD CONSTRAINT "backorders_passed_over_non_negative"
    CHECK ("passedOverCount" >= 0);

-- Status <-> timestamp coupling.
ALTER TABLE "backorders" ADD CONSTRAINT "backorders_cancelled_state"
    CHECK (
        (
            "status" = 'CANCELLED'
            AND "cancelledAt" IS NOT NULL
            AND "cancelledByKind" IS NOT NULL
        )
        OR (
            "status" <> 'CANCELLED'
            AND "cancelledAt" IS NULL
            AND "cancelledByKind" IS NULL
            AND "cancelledByUserId" IS NULL
            AND "cancelReason" IS NULL
        )
    );

-- Only a staff cancel can name a user.
ALTER TABLE "backorders" ADD CONSTRAINT "backorders_cancelled_by_user_is_staff"
    CHECK ("cancelledByUserId" IS NULL OR "cancelledByKind" = 'STAFF');

ALTER TABLE "backorders" ADD CONSTRAINT "backorders_reserved_state"
    CHECK (
        "status" <> 'RESERVED'
        OR (
            "reservedAt" IS NOT NULL
            AND "reservedUntil" IS NOT NULL
            AND "currentPriceCents" IS NOT NULL
            AND "finalPriceCents" IS NOT NULL
        )
    );

-- A WAITING backorder holds no reservation (also after RESERVED -> WAITING).
ALTER TABLE "backorders" ADD CONSTRAINT "backorders_waiting_state"
    CHECK (
        "status" <> 'WAITING'
        OR (
            "reservedAt" IS NULL
            AND "reservedUntil" IS NULL
            AND "reminderAt" IS NULL
        )
    );

ALTER TABLE "backorders" ADD CONSTRAINT "backorders_confirmed_state"
    CHECK (
        (
            "status" = 'CONFIRMED'
            AND "saleId" IS NOT NULL
            AND "confirmedAt" IS NOT NULL
        )
        OR (
            "status" <> 'CONFIRMED'
            AND "saleId" IS NULL
            AND "confirmedAt" IS NULL
        )
    );

ALTER TABLE "backorders" ADD CONSTRAINT "backorders_expired_state"
    CHECK (("status" = 'EXPIRED') = ("expiredAt" IS NOT NULL));
