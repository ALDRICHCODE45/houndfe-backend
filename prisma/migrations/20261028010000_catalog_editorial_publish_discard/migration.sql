-- Durable publish receipts are a distinct operation namespace.
CREATE TABLE "catalog_editorial_publish_receipts" (
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

-- Durable discard receipts are a distinct operation namespace.
CREATE TABLE "catalog_editorial_discard_receipts" (
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
