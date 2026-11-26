-- branch-location — the sucursal map pin on its shipping origin, so the
-- chatbot (GET /chatbot-api/branch) and the checkout pickupLocation can send
-- a WhatsApp location pin from the same source the POS already edits.
--
-- Additive only, hand-written: two nullable columns (metadata-only ADD
-- COLUMN, existing rows get NULL, no rewrite). The CHECKs keep the pin whole
-- (both or neither) and inside WGS84 ranges, mirroring the API validation.
ALTER TABLE "shipping_origins"
  ADD COLUMN "latitude" DOUBLE PRECISION,
  ADD COLUMN "longitude" DOUBLE PRECISION;

ALTER TABLE "shipping_origins"
  ADD CONSTRAINT "shipping_origins_coordinates_pair_check"
    CHECK (("latitude" IS NULL) = ("longitude" IS NULL)),
  ADD CONSTRAINT "shipping_origins_latitude_range_check"
    CHECK ("latitude" IS NULL OR "latitude" BETWEEN -90 AND 90),
  ADD CONSTRAINT "shipping_origins_longitude_range_check"
    CHECK ("longitude" IS NULL OR "longitude" BETWEEN -180 AND 180);
