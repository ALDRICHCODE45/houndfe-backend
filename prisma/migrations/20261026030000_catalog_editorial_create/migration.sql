-- Durable create receipts; no lifecycle cleanup or existing-data rewrite.
CREATE TABLE "catalog_editorial_create_receipts" (
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
