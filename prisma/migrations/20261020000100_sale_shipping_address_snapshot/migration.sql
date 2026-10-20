-- Preserve delivery facts independently of the mutable customer address.
-- Schema only: existing sales intentionally remain without a snapshot.
ALTER TABLE "sales"
  ADD COLUMN "shippingStreet" TEXT,
  ADD COLUMN "shippingExteriorNumber" TEXT,
  ADD COLUMN "shippingInteriorNumber" TEXT,
  ADD COLUMN "shippingZipCode" TEXT,
  ADD COLUMN "shippingNeighborhood" TEXT,
  ADD COLUMN "shippingMunicipality" TEXT,
  ADD COLUMN "shippingCity" TEXT,
  ADD COLUMN "shippingState" TEXT,
  ADD COLUMN "shippingVisualReferences" TEXT,
  ADD COLUMN "shippingCarrierPhone" TEXT,
  ADD COLUMN "shippingLabel" TEXT,
  ADD COLUMN "shippingLatitude" DOUBLE PRECISION,
  ADD COLUMN "shippingLongitude" DOUBLE PRECISION;
