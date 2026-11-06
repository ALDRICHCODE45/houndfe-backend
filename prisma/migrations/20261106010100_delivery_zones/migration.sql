-- shipping-zones / T1 (S1, S2) — delivery zones, zone validations and bot
-- requesters. Contract: docs/delivery-zones.md.
--
-- Additive: three new tables and three new enum types. No existing table is
-- altered; `human_decisions` and its enums keep every row and CHECK as is. The
-- human-decision status (`HumanDecisionStatus`) and bot outcome
-- (`HumanDecisionBotOutcome`) enums are only REUSED as column types.
--
-- Invariants owned by this migration (Prisma's DSL cannot express them):
--   * zone shape: SURCHARGE carries surchargeCents; FREE and SURCHARGE carry
--     etaDays; CARRIER_ONLY and DENIED carry neither.
--   * at most one PENDING validation per tenant + postal code (partial unique
--     index), so concurrent intakes for one postal code share one decision.
--   * validation resolution: PENDING v1 with no resolution, RESOLVED v2 with
--     the full audit; APPROVE settles FREE/SURCHARGE/CARRIER_ONLY, REJECT
--     settles DENIED.
--   * requester resolution: PENDING v1 or RESOLVED v2 with the zone outcome;
--     VALIDATION requires the validation link.
--   * requester ACK: the same terminal outcome/evidence coupling as
--     human_decisions, with a 24 h application window (WhatsApp window).
--
-- Rollback (manual; only objects introduced here):
--   DROP TABLE "delivery_zone_requests";
--   DROP TABLE "delivery_zone_validations";
--   DROP TABLE "delivery_zones";
--   DROP TYPE "DeliveryZoneRequestResolutionSource";
--   DROP TYPE "DeliveryZoneResolutionAction";
--   DROP TYPE "DeliveryZoneType";

-- CreateEnum
CREATE TYPE "DeliveryZoneType" AS ENUM ('FREE', 'SURCHARGE', 'CARRIER_ONLY', 'DENIED');

-- CreateEnum
CREATE TYPE "DeliveryZoneResolutionAction" AS ENUM ('APPROVE_DELIVERY_ZONE', 'REJECT_DELIVERY_ZONE');

-- CreateEnum
CREATE TYPE "DeliveryZoneRequestResolutionSource" AS ENUM ('VALIDATION', 'EXISTING_ZONE');


-- CreateTable
CREATE TABLE "delivery_zones" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "zipCode" VARCHAR(5) NOT NULL,
    "type" "DeliveryZoneType" NOT NULL,
    "surchargeCents" INTEGER,
    "etaDays" INTEGER,
    "state" TEXT,
    "municipality" TEXT,
    "neighborhood" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "approvedById" TEXT NOT NULL,
    "approvedByDisplayName" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL,
    "sourceValidationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_zone_validations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "zipCode" VARCHAR(5) NOT NULL,
    "state" TEXT NOT NULL,
    "municipality" TEXT NOT NULL,
    "neighborhood" TEXT NOT NULL,
    "branchName" TEXT,
    "status" "HumanDecisionStatus" NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "resolutionAction" "DeliveryZoneResolutionAction",
    "zoneType" "DeliveryZoneType",
    "surchargeCents" INTEGER,
    "etaDays" INTEGER,
    "resolutionRequestId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByActorId" TEXT,
    "resolvedByDisplayName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_zone_validations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_zone_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceRequestId" TEXT NOT NULL,
    "canonicalRequestHash" TEXT NOT NULL,
    "submittedCredentialId" TEXT NOT NULL,
    "validationId" TEXT,
    "branchName" TEXT,
    "zipCode" VARCHAR(5) NOT NULL,
    "state" TEXT NOT NULL,
    "municipality" TEXT NOT NULL,
    "neighborhood" TEXT NOT NULL,
    "customerPhoneCountryCode" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "conversationRef" TEXT NOT NULL,
    "lastCustomerMessageAt" TIMESTAMP(3) NOT NULL,
    "status" "HumanDecisionStatus" NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "resolutionSource" "DeliveryZoneRequestResolutionSource",
    "zoneType" "DeliveryZoneType",
    "surchargeCents" INTEGER,
    "etaDays" INTEGER,
    "resolvedAt" TIMESTAMP(3),
    "applicationOutcome" "HumanDecisionBotOutcome",
    "applicationAttemptId" TEXT,
    "applicationEvidenceHash" TEXT,
    "providerMessageId" TEXT,
    "providerAcceptedObservedAt" TIMESTAMP(3),
    "applicationAttemptedAt" TIMESTAMP(3),
    "ackReceivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_zone_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "delivery_zones_tenantId_isActive_zipCode_idx" ON "delivery_zones"("tenantId", "isActive", "zipCode");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_zones_tenantId_zipCode_key" ON "delivery_zones"("tenantId", "zipCode");

-- CreateIndex
CREATE INDEX "delivery_zone_validations_tenantId_status_createdAt_id_idx" ON "delivery_zone_validations"("tenantId", "status", "createdAt", "id");

-- CreateIndex
CREATE INDEX "delivery_zone_requests_validationId_status_idx" ON "delivery_zone_requests"("validationId", "status");

-- CreateIndex
CREATE INDEX "delivery_zone_requests_tenantId_status_lastCustomerMessageA_idx" ON "delivery_zone_requests"("tenantId", "status", "lastCustomerMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_zone_requests_tenantId_source_sourceRequestId_key" ON "delivery_zone_requests"("tenantId", "source", "sourceRequestId");

-- AddForeignKey
ALTER TABLE "delivery_zones" ADD CONSTRAINT "delivery_zones_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_zone_validations" ADD CONSTRAINT "delivery_zone_validations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_zone_requests" ADD CONSTRAINT "delivery_zone_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_zone_requests" ADD CONSTRAINT "delivery_zone_requests_validationId_fkey" FOREIGN KEY ("validationId") REFERENCES "delivery_zone_validations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex (partial; migration-authoritative)
-- One open validation per tenant + postal code. Resolved rows may repeat.
CREATE UNIQUE INDEX "delivery_zone_validations_one_pending_per_zip"
  ON "delivery_zone_validations"("tenantId", "zipCode")
  WHERE "status" = 'PENDING';

-- CheckConstraint — delivery_zones
ALTER TABLE "delivery_zones"
  ADD CONSTRAINT "delivery_zones_zip_code_format" CHECK ("zipCode" ~ '^[0-9]{5}$');

ALTER TABLE "delivery_zones"
  ADD CONSTRAINT "delivery_zones_surcharge_range"
    CHECK ("surchargeCents" IS NULL OR ("surchargeCents" >= 1 AND "surchargeCents" <= 100000000));

ALTER TABLE "delivery_zones"
  ADD CONSTRAINT "delivery_zones_eta_days_range"
    CHECK ("etaDays" IS NULL OR ("etaDays" >= 0 AND "etaDays" <= 60));

ALTER TABLE "delivery_zones"
  ADD CONSTRAINT "delivery_zones_type_shape"
    CHECK (
        ("type" = 'FREE' AND "surchargeCents" IS NULL AND "etaDays" IS NOT NULL)
        OR ("type" = 'SURCHARGE' AND "surchargeCents" IS NOT NULL AND "etaDays" IS NOT NULL)
        OR ("type" = 'CARRIER_ONLY' AND "surchargeCents" IS NULL AND "etaDays" IS NULL)
        OR ("type" = 'DENIED' AND "surchargeCents" IS NULL AND "etaDays" IS NULL)
      );

-- CheckConstraint — delivery_zone_validations
ALTER TABLE "delivery_zone_validations"
  ADD CONSTRAINT "delivery_zone_validations_zip_code_format" CHECK ("zipCode" ~ '^[0-9]{5}$');

ALTER TABLE "delivery_zone_validations"
  ADD CONSTRAINT "delivery_zone_validations_surcharge_range"
    CHECK ("surchargeCents" IS NULL OR ("surchargeCents" >= 1 AND "surchargeCents" <= 100000000));

ALTER TABLE "delivery_zone_validations"
  ADD CONSTRAINT "delivery_zone_validations_eta_days_range"
    CHECK ("etaDays" IS NULL OR ("etaDays" >= 0 AND "etaDays" <= 60));

ALTER TABLE "delivery_zone_validations"
  ADD CONSTRAINT "delivery_zone_validations_resolution_state"
    CHECK (
      (
        "status" = 'PENDING'
        AND "version" = 1
        AND "resolutionAction" IS NULL
        AND "zoneType" IS NULL
        AND "surchargeCents" IS NULL
        AND "etaDays" IS NULL
        AND "resolutionRequestId" IS NULL
        AND "resolvedAt" IS NULL
        AND "resolvedByActorId" IS NULL
        AND "resolvedByDisplayName" IS NULL
      )
      OR (
        "status" = 'RESOLVED'
        AND "version" = 2
        AND "resolutionAction" IS NOT NULL
        AND "zoneType" IS NOT NULL
        AND "resolutionRequestId" IS NOT NULL
        AND "resolvedAt" IS NOT NULL
        AND "resolvedByActorId" IS NOT NULL
        AND "resolvedByDisplayName" IS NOT NULL
        AND (
          ("resolutionAction" = 'APPROVE_DELIVERY_ZONE' AND "zoneType" IN ('FREE', 'SURCHARGE', 'CARRIER_ONLY'))
          OR ("resolutionAction" = 'REJECT_DELIVERY_ZONE' AND "zoneType" = 'DENIED')
        )
        AND (
        ("zoneType" = 'FREE' AND "surchargeCents" IS NULL AND "etaDays" IS NOT NULL)
        OR ("zoneType" = 'SURCHARGE' AND "surchargeCents" IS NOT NULL AND "etaDays" IS NOT NULL)
        OR ("zoneType" = 'CARRIER_ONLY' AND "surchargeCents" IS NULL AND "etaDays" IS NULL)
        OR ("zoneType" = 'DENIED' AND "surchargeCents" IS NULL AND "etaDays" IS NULL)
      )
      )
    );

-- CheckConstraint — delivery_zone_requests
ALTER TABLE "delivery_zone_requests"
  ADD CONSTRAINT "delivery_zone_requests_zip_code_format" CHECK ("zipCode" ~ '^[0-9]{5}$');

ALTER TABLE "delivery_zone_requests"
  ADD CONSTRAINT "delivery_zone_requests_surcharge_range"
    CHECK ("surchargeCents" IS NULL OR ("surchargeCents" >= 1 AND "surchargeCents" <= 100000000));

ALTER TABLE "delivery_zone_requests"
  ADD CONSTRAINT "delivery_zone_requests_eta_days_range"
    CHECK ("etaDays" IS NULL OR ("etaDays" >= 0 AND "etaDays" <= 60));

ALTER TABLE "delivery_zone_requests"
  ADD CONSTRAINT "delivery_zone_requests_resolution_state"
    CHECK (
      (
        "status" = 'PENDING'
        AND "version" = 1
        AND "validationId" IS NOT NULL
        AND "resolutionSource" IS NULL
        AND "zoneType" IS NULL
        AND "surchargeCents" IS NULL
        AND "etaDays" IS NULL
        AND "resolvedAt" IS NULL
      )
      OR (
        "status" = 'RESOLVED'
        AND "version" = 2
        AND "resolutionSource" IS NOT NULL
        AND "zoneType" IS NOT NULL
        AND "resolvedAt" IS NOT NULL
        AND ("resolutionSource" = 'EXISTING_ZONE' OR "validationId" IS NOT NULL)
        AND (
        ("zoneType" = 'FREE' AND "surchargeCents" IS NULL AND "etaDays" IS NOT NULL)
        OR ("zoneType" = 'SURCHARGE' AND "surchargeCents" IS NOT NULL AND "etaDays" IS NOT NULL)
        OR ("zoneType" = 'CARRIER_ONLY' AND "surchargeCents" IS NULL AND "etaDays" IS NULL)
        OR ("zoneType" = 'DENIED' AND "surchargeCents" IS NULL AND "etaDays" IS NULL)
      )
      )
    );

-- CheckConstraint — requester terminal ACK (same coupling as
-- human_decisions_application_outcome_state, fixed 24 h window).
ALTER TABLE "delivery_zone_requests"
  ADD CONSTRAINT "delivery_zone_requests_application_outcome_state"
    CHECK (
      (
        "applicationOutcome" IS NULL
        AND "applicationAttemptId" IS NULL
        AND "applicationEvidenceHash" IS NULL
        AND "providerMessageId" IS NULL
        AND "providerAcceptedObservedAt" IS NULL
        AND "applicationAttemptedAt" IS NULL
        AND "ackReceivedAt" IS NULL
      )
      OR (
        "applicationOutcome" IS NOT NULL
        AND "status" = 'RESOLVED'
        AND "resolvedAt" IS NOT NULL
        AND "applicationAttemptId" IS NOT NULL
        AND "applicationEvidenceHash" IS NOT NULL
        AND "ackReceivedAt" IS NOT NULL
        AND (
          (
            "applicationOutcome" = 'PROVIDER_ACCEPTED'
            AND "providerMessageId" IS NOT NULL
            AND "providerAcceptedObservedAt" IS NOT NULL
            AND "providerAcceptedObservedAt" >= "resolvedAt"
            AND "providerAcceptedObservedAt" < "resolvedAt" + INTERVAL '24 hours'
            AND "applicationAttemptedAt" IS NOT NULL
            AND "applicationAttemptedAt" >= "resolvedAt"
            AND "applicationAttemptedAt" < "resolvedAt" + INTERVAL '24 hours'
          )
          OR (
            "applicationOutcome" = 'PROVIDER_ACCEPTED_LATE'
            AND "providerMessageId" IS NOT NULL
            AND "providerAcceptedObservedAt" IS NOT NULL
            AND "providerAcceptedObservedAt" >= "resolvedAt" + INTERVAL '24 hours'
            AND "applicationAttemptedAt" IS NOT NULL
            AND "applicationAttemptedAt" >= "resolvedAt"
            AND "applicationAttemptedAt" < "resolvedAt" + INTERVAL '24 hours'
          )
          OR (
            "applicationOutcome" = 'DELIVERY_UNKNOWN'
            AND "providerAcceptedObservedAt" IS NULL
            AND "applicationAttemptedAt" IS NOT NULL
            AND "applicationAttemptedAt" >= "resolvedAt"
            AND "applicationAttemptedAt" < "resolvedAt" + INTERVAL '24 hours'
          )
          OR (
            "applicationOutcome" = 'STALE'
            AND "applicationAttemptedAt" IS NULL
            AND "providerMessageId" IS NULL
            AND "providerAcceptedObservedAt" IS NULL
          )
        )
      )
    );
