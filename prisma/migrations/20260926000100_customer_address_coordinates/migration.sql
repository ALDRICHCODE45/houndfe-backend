-- Existing rows remain unlocated; no coordinate default or backfill.
ALTER TABLE "customer_addresses"
  ADD COLUMN "latitude" DOUBLE PRECISION,
  ADD COLUMN "longitude" DOUBLE PRECISION;

ALTER TABLE "customer_addresses"
  ADD CONSTRAINT "customer_addresses_coordinate_pair_check"
  CHECK (
    ("latitude" IS NULL AND "longitude" IS NULL)
    OR (
      "latitude" IS NOT NULL AND "longitude" IS NOT NULL
      AND "latitude" BETWEEN -90 AND 90
      AND "longitude" BETWEEN -180 AND 180
    )
  );
