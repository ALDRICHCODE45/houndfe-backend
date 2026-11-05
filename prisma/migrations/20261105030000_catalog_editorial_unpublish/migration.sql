-- P4 S6: unpublish removes Published. The removed revision is kept so a later
-- publish continues numbering (no cycle/Published-revision pair is reused).
ALTER TABLE "catalog_editorial_states" ADD COLUMN "unpublishedRevision" INTEGER;
ALTER TABLE "catalog_editorial_states"
  ADD CONSTRAINT "catalog_editorial_states_unpublished_revision_check"
  CHECK ("unpublishedRevision" IS NULL OR "unpublishedRevision" > 0);

-- Durable unpublish receipts are a distinct operation namespace.
CREATE TABLE "catalog_editorial_unpublish_receipts" (
  "tenantId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "request" JSONB NOT NULL,
  "result" JSONB NOT NULL,
  PRIMARY KEY ("tenantId", "productId", "actorId", "idempotencyKey"),
  FOREIGN KEY ("tenantId", "productId")
    REFERENCES "catalog_editorial_states" ("tenantId", "productId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CHECK (length("idempotencyKey") BETWEEN 1 AND 200)
);
