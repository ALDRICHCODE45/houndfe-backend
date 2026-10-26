CREATE TABLE "private_media_assets" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "private_media_assets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "private_media_assets_sizeBytes_check" CHECK ("sizeBytes" > 0 AND "sizeBytes" <= 10485760),
    CONSTRAINT "private_media_assets_mimeType_check" CHECK ("mimeType" IN ('image/jpeg', 'image/png', 'image/webp'))
);

CREATE UNIQUE INDEX "private_media_assets_storageKey_key" ON "private_media_assets"("storageKey");
CREATE INDEX "private_media_assets_tenantId_productId_idx" ON "private_media_assets"("tenantId", "productId");
ALTER TABLE "private_media_assets" ADD CONSTRAINT "private_media_assets_tenantId_productId_fkey"
    FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
