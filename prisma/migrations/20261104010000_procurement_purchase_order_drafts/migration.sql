-- Additive draft storage only. No existing data, role grants, stock or money changes.
-- UUID identifiers use TEXT to match supplier/tenant storage conventions.
CREATE TYPE "ProcurementPurchaseOrderStatus" AS ENUM ('DRAFT');
CREATE TYPE "ProcurementPurchaseOrderOperation" AS ENUM ('CREATE', 'REPLACE', 'DELETE');
CREATE TYPE "ProcurementPurchaseOrderTaxBasis" AS ENUM ('INCLUDES_TAX', 'EXCLUDES_TAX');

CREATE TABLE "procurement_purchase_orders" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "supplierId" TEXT,
  "status" "ProcurementPurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
  "version" INTEGER NOT NULL DEFAULT 1,
  "note" TEXT,
  "locationDetail" TEXT,
  "locationTenantName" TEXT NOT NULL,
  "supplierDisplaySnapshot" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "procurement_purchase_orders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "po_version_check" CHECK ("version" > 0),
  CONSTRAINT "po_note_check" CHECK ("note" IS NULL OR char_length("note") <= 2000),
  CONSTRAINT "po_location_check" CHECK ("locationDetail" IS NULL OR char_length("locationDetail") <= 500),
  CONSTRAINT "po_tenant_fk" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "po_supplier_fk" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "procurement_suppliers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "procurement_purchase_orders_tenantId_id_key" ON "procurement_purchase_orders"("tenantId", "id");
CREATE INDEX "procurement_purchase_orders_tenantId_createdAt_id_idx" ON "procurement_purchase_orders"("tenantId", "createdAt" DESC, "id" DESC);
CREATE INDEX "procurement_purchase_orders_tenantId_supplierId_createdAt_id_idx" ON "procurement_purchase_orders"("tenantId", "supplierId", "createdAt" DESC, "id" DESC);

CREATE TABLE "procurement_purchase_order_lines" (
  "tenantId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "lineId" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  -- Historical tenant-qualified scalar references, intentionally no product/variant FKs.
  "productId" TEXT,
  "variantId" TEXT,
  "orderedQuantity" TEXT,
  "informedUnitCostPresent" BOOLEAN NOT NULL DEFAULT false,
  "costAmount" TEXT,
  "currency" TEXT,
  "costUnit" "UnitOfMeasure",
  "taxBasis" "ProcurementPurchaseOrderTaxBasis",
  "productName" TEXT,
  "variantName" TEXT,
  "unitSnapshot" "UnitOfMeasure",
  CONSTRAINT "po_line_identity_pk" PRIMARY KEY ("tenantId", "orderId", "lineId"),
  CONSTRAINT "po_line_position_check" CHECK ("position" >= 0),
  -- CASE guards the numeric cast even for malformed direct SQL writes.
  CONSTRAINT "po_line_quantity_check" CHECK ("orderedQuantity" IS NULL OR CASE
    WHEN "orderedQuantity" ~ '^(0|[1-9][0-9]{0,8})(\.[0-9]{1,3})?$'
    THEN "orderedQuantity"::numeric > 0 ELSE false END),
  CONSTRAINT "po_line_amount_check" CHECK ("costAmount" IS NULL OR "costAmount" ~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,4})?$'),
  CONSTRAINT "po_line_currency_check" CHECK ("currency" IS NULL OR "currency" = 'MXN'),
  CONSTRAINT "po_line_cost_presence_check" CHECK ("informedUnitCostPresent" OR
    ("costAmount" IS NULL AND "currency" IS NULL AND "costUnit" IS NULL AND "taxBasis" IS NULL)),
  CONSTRAINT "po_line_tenant_fk" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "po_line_order_fk" FOREIGN KEY ("tenantId", "orderId") REFERENCES "procurement_purchase_orders"("tenantId", "id") ON DELETE CASCADE ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "po_line_position_key" ON "procurement_purchase_order_lines"("tenantId", "orderId", "position");

-- Audit and receipts deliberately reference only the tenant, not the live order or actor.
CREATE TABLE "procurement_purchase_order_audits" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "operation" "ProcurementPurchaseOrderOperation" NOT NULL,
  "orderVersion" INTEGER NOT NULL,
  "beforeSnapshot" JSONB,
  "afterSnapshot" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "procurement_purchase_order_audits_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "po_audit_version_check" CHECK ("orderVersion" > 0),
  CONSTRAINT "po_audit_snapshots_check" CHECK (
    ("operation" = 'CREATE' AND "beforeSnapshot" IS NULL AND "afterSnapshot" IS NOT NULL AND jsonb_typeof("afterSnapshot") = 'object') OR
    ("operation" = 'REPLACE' AND "beforeSnapshot" IS NOT NULL AND jsonb_typeof("beforeSnapshot") = 'object' AND "afterSnapshot" IS NOT NULL AND jsonb_typeof("afterSnapshot") = 'object') OR
    ("operation" = 'DELETE' AND "beforeSnapshot" IS NOT NULL AND jsonb_typeof("beforeSnapshot") = 'object' AND "afterSnapshot" IS NULL)),
  CONSTRAINT "po_audit_tenant_fk" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "po_audit_version_key" ON "procurement_purchase_order_audits"("tenantId", "orderId", "orderVersion");

CREATE TABLE "procurement_purchase_order_receipts" (
  "tenantId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "operation" "ProcurementPurchaseOrderOperation" NOT NULL,
  "target" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "statusCode" INTEGER NOT NULL,
  "responseBody" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "po_receipt_namespace_pk" PRIMARY KEY ("tenantId", "actorId", "operation", "target", "idempotencyKey"),
  CONSTRAINT "po_receipt_namespace_check" CHECK (
    ("operation" = 'CREATE' AND "target" = 'collection') OR
    ("operation" IN ('REPLACE', 'DELETE') AND "target" = "orderId")),
  CONSTRAINT "po_receipt_key_check" CHECK (char_length("idempotencyKey") BETWEEN 1 AND 200),
  CONSTRAINT "po_receipt_hash_check" CHECK ("requestHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "po_receipt_http_check" CHECK (
    ("operation" = 'CREATE' AND "statusCode" = 201) OR
    ("operation" = 'REPLACE' AND "statusCode" = 200) OR
    ("operation" = 'DELETE' AND "statusCode" = 204 AND "responseBody" = 'null'::jsonb)),
  CONSTRAINT "po_receipt_tenant_fk" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "procurement_purchase_order_receipts_tenantId_orderId_idx" ON "procurement_purchase_order_receipts"("tenantId", "orderId");
