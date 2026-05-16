CREATE TABLE "sale_comments" (
  "id" TEXT NOT NULL,
  "saleId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "authorUserId" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),

  CONSTRAINT "sale_comments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sale_comments_saleId_createdAt_idx" ON "sale_comments"("saleId", "createdAt");
CREATE INDEX "sale_comments_tenantId_idx" ON "sale_comments"("tenantId");

ALTER TABLE "sale_comments"
  ADD CONSTRAINT "sale_comments_saleId_fkey"
  FOREIGN KEY ("saleId") REFERENCES "sales"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "sale_comments"
  ADD CONSTRAINT "sale_comments_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "sale_comments"
  ADD CONSTRAINT "sale_comments_authorUserId_fkey"
  FOREIGN KEY ("authorUserId") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
