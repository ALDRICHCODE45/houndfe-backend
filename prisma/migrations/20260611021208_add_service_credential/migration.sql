-- CreateTable
CREATE TABLE "service_credentials" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hashedKey" TEXT NOT NULL,
    "scopes" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMP(3),
    "rateLimit" INTEGER NOT NULL DEFAULT 60,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "service_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_credentials_hashedKey_key" ON "service_credentials"("hashedKey");

-- CreateIndex
CREATE INDEX "service_credentials_tenantId_isActive_idx" ON "service_credentials"("tenantId", "isActive");

-- AddForeignKey
ALTER TABLE "service_credentials" ADD CONSTRAINT "service_credentials_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
