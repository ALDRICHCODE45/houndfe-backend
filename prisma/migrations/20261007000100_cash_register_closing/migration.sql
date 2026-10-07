-- cash-register-closing / T2 — additive persistence foundation for the POS
-- cash-register feature (S1, S3, S8).
--
-- Additive and safe for populated databases: four new enum types and seven new
-- tables. No existing table is altered, so no historical row changes meaning
-- and there is no backfill. In particular, `sales`, `sale_payments` and
-- `sale_refunds` are untouched: POS linkage is by `CashMovement` source
-- identity, and T4 wires the sales/refund paths deliberately.
--
-- Tenant safety is structural. Every table carries `tenantId` (FK to
-- `tenants` with ON DELETE CASCADE, the project-wide pattern), and every
-- cash-to-cash FK is tenant-qualified — `FOREIGN KEY ("tenantId", <id>)
-- REFERENCES <cash_table>("tenantId", "id")` — so PostgreSQL itself rejects a
-- cross-tenant register/session/handover link even if the application forgets
-- a guard.
--
-- Audit retention: every actor FK (cashier, movement actor, count actor,
-- handover recipient/creator, closer) is NOT NULL with ON DELETE RESTRICT, so
-- deleting a User can never erase who opened, moved, counted, handed over or
-- closed cash.
--
-- The one-unreleased-session-per-register guarantee is a PARTIAL UNIQUE INDEX
-- (`WHERE "drawerReleasedAt" IS NULL`) because Prisma's DSL cannot express
-- partial indexes: a register may have at most one session whose drawer has
-- not been released, regardless of OPEN/COUNTING/SUBMITTED review state.
--
-- Rollback (manual; only objects introduced by this migration):
--   DROP TABLE "cash_commands";
--   DROP TABLE "cash_closings";
--   DROP TABLE "cash_handovers";
--   DROP TABLE "cash_counts";
--   DROP TABLE "cash_movements";
--   DROP TABLE "cash_sessions";
--   DROP TABLE "cash_registers";
--   DROP TYPE "CashHandoverKind";
--   DROP TYPE "CashCountKind";
--   DROP TYPE "CashMovementKind";
--   DROP TYPE "CashSessionStatus";
-- Dropping the tables removes their pkeys, unique/index constraints, CHECK
-- constraints and FKs, so they need no separate statement above.

-- CreateEnum
CREATE TYPE "CashSessionStatus" AS ENUM ('OPEN', 'COUNTING', 'SUBMITTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "CashMovementKind" AS ENUM ('SALE_PAYMENT', 'SALE_CHANGE', 'REFUND_SETTLEMENT', 'CASH_IN', 'CASH_OUT');

-- CreateEnum
CREATE TYPE "CashCountKind" AS ENUM ('DECLARATION', 'VERIFICATION');

-- CreateEnum
CREATE TYPE "CashHandoverKind" AS ENUM ('WITHDRAWAL', 'FLOAT');

-- CreateTable
CREATE TABLE "cash_registers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cash_registers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cash_registers_tenantId_name_key" ON "cash_registers"("tenantId", "name");

-- CreateIndex
-- Composite-FK target so CashSession.registerId carries tenant ownership.
CREATE UNIQUE INDEX "cash_registers_tenantId_id_key" ON "cash_registers"("tenantId", "id");

-- CreateIndex
CREATE INDEX "cash_registers_tenantId_isActive_idx" ON "cash_registers"("tenantId", "isActive");

-- CreateTable
CREATE TABLE "cash_sessions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "registerId" TEXT NOT NULL,
    "cashierUserId" TEXT NOT NULL,
    "openingCents" INTEGER NOT NULL,
    "status" "CashSessionStatus" NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "frozenAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "drawerReleasedAt" TIMESTAMP(3),
    "openingHandoverId" TEXT,
    "expectedJson" JSONB,

    CONSTRAINT "cash_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cash_sessions_tenantId_id_key" ON "cash_sessions"("tenantId", "id");

-- CreateIndex
-- Exactly-once float reuse: one FLOAT handover funds at most one session.
CREATE UNIQUE INDEX "cash_sessions_tenantId_openingHandoverId_key" ON "cash_sessions"("tenantId", "openingHandoverId");

-- CreateIndex
CREATE INDEX "cash_sessions_tenantId_registerId_status_idx" ON "cash_sessions"("tenantId", "registerId", "status");

-- CreateIndex
CREATE INDEX "cash_sessions_tenantId_cashierUserId_openedAt_idx" ON "cash_sessions"("tenantId", "cashierUserId", "openedAt");

-- CreateIndex
-- One unreleased (drawerReleasedAt IS NULL) session per register. Partial
-- unique index is migration-authoritative; Prisma's DSL cannot express it.
CREATE UNIQUE INDEX "cash_sessions_one_unreleased_per_register" ON "cash_sessions"("tenantId", "registerId") WHERE "drawerReleasedAt" IS NULL;

-- CreateTable
CREATE TABLE "cash_movements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "kind" "CashMovementKind" NOT NULL,
    "deltaCents" INTEGER NOT NULL,
    "method" "SalePaymentMethod" NOT NULL,
    "channelKey" TEXT NOT NULL,
    "channelLabel" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "reason" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Source uniqueness prevents replaying the same POS source into cash twice.
CREATE UNIQUE INDEX "cash_movements_tenantId_sourceType_sourceId_key" ON "cash_movements"("tenantId", "sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "cash_movements_tenantId_sessionId_occurredAt_idx" ON "cash_movements"("tenantId", "sessionId", "occurredAt");

-- CreateIndex
CREATE INDEX "cash_movements_tenantId_actorUserId_idx" ON "cash_movements"("tenantId", "actorUserId");

-- CreateTable
CREATE TABLE "cash_counts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "kind" "CashCountKind" NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "actorUserId" TEXT NOT NULL,
    "linesJson" JSONB NOT NULL,
    "denominationsJson" JSONB,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_counts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Originals are preserved: a recount is a new revision, never an update.
CREATE UNIQUE INDEX "cash_counts_tenantId_sessionId_kind_revision_key" ON "cash_counts"("tenantId", "sessionId", "kind", "revision");

-- CreateIndex
CREATE INDEX "cash_counts_tenantId_sessionId_kind_createdAt_idx" ON "cash_counts"("tenantId", "sessionId", "kind", "createdAt");

-- CreateTable
CREATE TABLE "cash_handovers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sourceSessionId" TEXT NOT NULL,
    "kind" "CashHandoverKind" NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "declaredCents" INTEGER NOT NULL,
    "receivedCents" INTEGER,
    "notes" TEXT,
    "receiptNotes" TEXT,
    "receivedAt" TIMESTAMP(3),
    "receivedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_handovers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Composite-FK target for CashSession.openingHandoverId.
CREATE UNIQUE INDEX "cash_handovers_tenantId_id_key" ON "cash_handovers"("tenantId", "id");

-- CreateIndex
CREATE INDEX "cash_handovers_tenantId_sourceSessionId_createdAt_idx" ON "cash_handovers"("tenantId", "sourceSessionId", "createdAt");

-- CreateIndex
CREATE INDEX "cash_handovers_tenantId_recipientUserId_idx" ON "cash_handovers"("tenantId", "recipientUserId");

-- CreateTable
CREATE TABLE "cash_closings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "folio" TEXT NOT NULL,
    "closedByUserId" TEXT NOT NULL,
    "snapshotJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_closings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cash_closings_tenantId_sessionId_key" ON "cash_closings"("tenantId", "sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "cash_closings_tenantId_folio_key" ON "cash_closings"("tenantId", "folio");

-- CreateIndex
CREATE INDEX "cash_closings_tenantId_createdAt_idx" ON "cash_closings"("tenantId", "createdAt");

-- CreateTable
CREATE TABLE "cash_commands" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_commands_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Request idempotency: same (tenant, key) with a different requestHash is a
-- conflict, and a replayed request returns the stored response.
CREATE UNIQUE INDEX "cash_commands_tenantId_key_key" ON "cash_commands"("tenantId", "key");

-- CreateIndex
CREATE INDEX "cash_commands_tenantId_createdAt_idx" ON "cash_commands"("tenantId", "createdAt");

-- CheckConstraint
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_opening_cents_nonnegative" CHECK ("openingCents" >= 0);

-- CheckConstraint
-- Cash sessions never track credit; CREDIT is rejected by the database.
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_method_not_credit" CHECK ("method" <> 'CREDIT');

-- CheckConstraint
-- Signed direction per kind, which also forbids a zero operational delta:
-- money in for SALE_PAYMENT / CASH_IN, money out for SALE_CHANGE /
-- REFUND_SETTLEMENT / CASH_OUT.
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_delta_direction" CHECK (
    ("kind" = 'SALE_PAYMENT' AND "deltaCents" > 0)
    OR ("kind" = 'SALE_CHANGE' AND "deltaCents" < 0)
    OR ("kind" = 'REFUND_SETTLEMENT' AND "deltaCents" < 0)
    OR ("kind" = 'CASH_IN' AND "deltaCents" > 0)
    OR ("kind" = 'CASH_OUT' AND "deltaCents" < 0)
);

-- CheckConstraint
ALTER TABLE "cash_counts" ADD CONSTRAINT "cash_counts_revision_positive" CHECK ("revision" >= 1);

-- CheckConstraint
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_declared_cents_nonnegative" CHECK ("declaredCents" >= 0);

-- CheckConstraint
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_received_cents_nonnegative" CHECK ("receivedCents" IS NULL OR "receivedCents" >= 0);

-- CheckConstraint
-- The receipt actor and the receipt time are recorded together or not at all:
-- a receipt event must never lose who received the cash or when.
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_receipt_actor_state" CHECK (
    ("receivedByUserId" IS NULL AND "receivedAt" IS NULL)
    OR ("receivedByUserId" IS NOT NULL AND "receivedAt" IS NOT NULL)
);

-- AddForeignKey
ALTER TABLE "cash_registers" ADD CONSTRAINT "cash_registers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_tenantId_registerId_fkey" FOREIGN KEY ("tenantId", "registerId") REFERENCES "cash_registers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_cashierUserId_fkey" FOREIGN KEY ("cashierUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_tenantId_openingHandoverId_fkey" FOREIGN KEY ("tenantId", "openingHandoverId") REFERENCES "cash_handovers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_tenantId_sessionId_fkey" FOREIGN KEY ("tenantId", "sessionId") REFERENCES "cash_sessions"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_counts" ADD CONSTRAINT "cash_counts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_counts" ADD CONSTRAINT "cash_counts_tenantId_sessionId_fkey" FOREIGN KEY ("tenantId", "sessionId") REFERENCES "cash_sessions"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_counts" ADD CONSTRAINT "cash_counts_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_tenantId_sourceSessionId_fkey" FOREIGN KEY ("tenantId", "sourceSessionId") REFERENCES "cash_sessions"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_receivedByUserId_fkey" FOREIGN KEY ("receivedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_closings" ADD CONSTRAINT "cash_closings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_closings" ADD CONSTRAINT "cash_closings_tenantId_sessionId_fkey" FOREIGN KEY ("tenantId", "sessionId") REFERENCES "cash_sessions"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_closings" ADD CONSTRAINT "cash_closings_closedByUserId_fkey" FOREIGN KEY ("closedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_commands" ADD CONSTRAINT "cash_commands_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
