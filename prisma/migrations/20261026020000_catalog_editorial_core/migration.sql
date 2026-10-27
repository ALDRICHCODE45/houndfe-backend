-- Additive artifact. Never apply to an existing database in this subunit.
CREATE UNIQUE INDEX "products_tenantId_id_key" ON "products" ("tenantId", "id");
CREATE TABLE "catalog_editorial_states" (
  "tenantId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "cycle" INTEGER NOT NULL CHECK ("cycle" > 0),
  "draftRevision" INTEGER,
  "basePublishedRevision" INTEGER,
  "draftDocument" JSONB,
  "publishedRevision" INTEGER,
  "publishedDocument" JSONB,
  PRIMARY KEY ("tenantId", "productId"),
  FOREIGN KEY ("tenantId", "productId") REFERENCES "products" ("tenantId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CHECK (
    ("draftRevision" IS NULL AND "draftDocument" IS NULL AND "basePublishedRevision" IS NULL)
    OR ("draftRevision" IS NOT NULL AND "draftRevision" > 0 AND "draftDocument" IS NOT NULL
      AND jsonb_typeof("draftDocument") = 'object'
      AND ("basePublishedRevision" IS NULL OR "basePublishedRevision" > 0))
  ),
  CHECK (
    ("publishedRevision" IS NULL AND "publishedDocument" IS NULL)
    OR ("publishedRevision" IS NOT NULL AND "publishedRevision" > 0
      AND "publishedDocument" IS NOT NULL AND jsonb_typeof("publishedDocument") = 'object')
  )
);
