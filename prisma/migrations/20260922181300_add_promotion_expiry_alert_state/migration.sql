-- promotion-capacity-alerts / pca-3a1 — durable promotion expiry-alert state.
-- Schema-only: no repository/service code reads or writes this table yet.
--
-- One durable row per (tenant, promotion, effective endDate fingerprint). An
-- A→B→A endDate change reuses the original A row instead of inserting a second
-- one, so a given effective endDate can never re-alert after it was sent. The
-- composite `(tenantId, promotionId)` FK reuses the `promotions_tenantId_id_key`
-- unique target created by pca-1a, so the database — not the application —
-- rejects a cross-tenant state row. `alertEpoch` is DB-guarded non-negative.
--
-- Additive and safe for populated databases: new table only, no column change
-- on existing tables, and no backfill — alerting begins at feature deployment.
--
-- Rollback (manual; only objects introduced by this migration):
--   ALTER TABLE "promotion_expiry_alert_states" DROP CONSTRAINT "promotion_expiry_alert_states_alert_epoch_nonnegative";
--   DROP TABLE "promotion_expiry_alert_states";
-- Dropping the table also drops its pkey, unique/index, and both FKs, so those
-- need no separate statement above. `promotions_tenantId_id_key` is owned by
-- pca-1a and MUST NOT be dropped here.

-- CreateTable
CREATE TABLE "promotion_expiry_alert_states" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "endDateFingerprint" TEXT NOT NULL,
    "alerted" BOOLEAN NOT NULL DEFAULT false,
    "alertEpoch" INTEGER NOT NULL DEFAULT 0,
    "alertedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "promotion_expiry_alert_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Fingerprint identity: at most one durable state row per effective endDate.
CREATE UNIQUE INDEX "promotion_expiry_alert_states_fingerprint_key" ON "promotion_expiry_alert_states"("tenantId", "promotionId", "endDateFingerprint");

-- CreateIndex
CREATE INDEX "promotion_expiry_alert_states_tenantId_idx" ON "promotion_expiry_alert_states"("tenantId");

-- CheckConstraint
-- Alert cycle counter lives in the database, not only in application code.
ALTER TABLE "promotion_expiry_alert_states"
  ADD CONSTRAINT "promotion_expiry_alert_states_alert_epoch_nonnegative"
    CHECK ("alertEpoch" >= 0);

-- AddForeignKey
ALTER TABLE "promotion_expiry_alert_states" ADD CONSTRAINT "promotion_expiry_alert_states_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Composite ownership: a state row can never point at another tenant's promotion.
ALTER TABLE "promotion_expiry_alert_states" ADD CONSTRAINT "promotion_expiry_alert_states_tenantId_promotionId_fkey" FOREIGN KEY ("tenantId", "promotionId") REFERENCES "promotions"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
