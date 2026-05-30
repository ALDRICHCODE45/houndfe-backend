-- AlterTable
ALTER TABLE "products" ADD COLUMN     "hidePriceInOnlineCatalog" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "products_tenantId_includeInOnlineCatalog_categoryId_idx" ON "products"("tenantId", "includeInOnlineCatalog", "categoryId");

-- CreateIndex
CREATE INDEX "products_tenantId_includeInOnlineCatalog_createdAt_idx" ON "products"("tenantId", "includeInOnlineCatalog", "createdAt" DESC);
