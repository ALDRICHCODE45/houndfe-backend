-- CreateTable
CREATE TABLE "bot_audit_logs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bot_audit_logs_tenantId_credentialId_createdAt_idx" ON "bot_audit_logs"("tenantId", "credentialId", "createdAt");

-- AddForeignKey
ALTER TABLE "bot_audit_logs" ADD CONSTRAINT "bot_audit_logs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_audit_logs" ADD CONSTRAINT "bot_audit_logs_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "service_credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;
