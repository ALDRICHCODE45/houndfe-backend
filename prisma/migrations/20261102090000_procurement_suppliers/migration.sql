-- Additive supplier-only storage. No roles, existing rows or business effects.
CREATE TYPE "ProcurementSupplierStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "ProcurementSupplierOperation" AS ENUM ('CREATE', 'UPDATE');

CREATE TABLE "procurement_suppliers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "termsText" TEXT,
    "status" "ProcurementSupplierStatus" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "procurement_suppliers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "supplier_name_check" CHECK (char_length("displayName") <= 200 AND
      char_length(btrim("displayName", U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) > 0),
    CONSTRAINT "supplier_terms_check" CHECK ("termsText" IS NULL OR char_length("termsText") <= 4000),
    CONSTRAINT "supplier_version_check" CHECK ("version" > 0),
    CONSTRAINT "supplier_tenant_fk" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "procurement_suppliers_tenantId_id_key" ON "procurement_suppliers"("tenantId", "id");
CREATE INDEX "procurement_suppliers_tenantId_createdAt_id_idx" ON "procurement_suppliers"("tenantId", "createdAt" DESC, "id" DESC);
CREATE INDEX "procurement_suppliers_tenantId_status_createdAt_id_idx" ON "procurement_suppliers"("tenantId", "status", "createdAt" DESC, "id" DESC);

CREATE TABLE "procurement_supplier_audits" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "operation" "ProcurementSupplierOperation" NOT NULL,
    "supplierVersion" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "procurement_supplier_audits_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "supplier_audit_version_check" CHECK ("supplierVersion" > 0),
    CONSTRAINT "supplier_audit_tenant_fk" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "supplier_audit_supplier_fk" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "procurement_suppliers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "supplier_audit_version_key" ON "procurement_supplier_audits"("tenantId", "supplierId", "supplierVersion");

CREATE TABLE "procurement_supplier_receipts" (
    "tenantId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "operation" "ProcurementSupplierOperation" NOT NULL,
    "target" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "responseBody" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "supplier_receipt_namespace_pk" PRIMARY KEY ("tenantId", "actorId", "operation", "target", "idempotencyKey"),
    CONSTRAINT "supplier_receipt_namespace_check" CHECK (
      ("operation" = 'CREATE' AND "target" = 'collection') OR
      ("operation" = 'UPDATE' AND "target" = "supplierId")),
    CONSTRAINT "supplier_receipt_key_check" CHECK (char_length("idempotencyKey") BETWEEN 1 AND 200),
    CONSTRAINT "supplier_receipt_hash_check" CHECK ("requestHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "supplier_receipt_http_check" CHECK (
      ("operation" = 'CREATE' AND "statusCode" = 201) OR
      ("operation" = 'UPDATE' AND "statusCode" = 200)),
    CONSTRAINT "supplier_receipt_tenant_fk" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "supplier_receipt_supplier_fk" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "procurement_suppliers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "procurement_supplier_receipts_tenantId_supplierId_idx" ON "procurement_supplier_receipts"("tenantId", "supplierId");
