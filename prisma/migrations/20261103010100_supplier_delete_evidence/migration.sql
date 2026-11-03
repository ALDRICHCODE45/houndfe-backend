-- Authorized hard deletion: retain historical scalar supplier IDs and tenant FKs.
-- No rows/evidence are rewritten or removed; old migrations remain immutable.
ALTER TABLE "procurement_supplier_audits"
  DROP CONSTRAINT "supplier_audit_supplier_fk";
ALTER TABLE "procurement_supplier_receipts"
  DROP CONSTRAINT "supplier_receipt_supplier_fk",
  DROP CONSTRAINT "supplier_receipt_namespace_check",
  DROP CONSTRAINT "supplier_receipt_http_check";

ALTER TABLE "procurement_supplier_receipts"
  ADD CONSTRAINT "supplier_receipt_namespace_check" CHECK (
    ("operation" = 'CREATE' AND "target" = 'collection') OR
    ("operation" IN ('UPDATE', 'DELETE') AND "target" = "supplierId")),
  ADD CONSTRAINT "supplier_receipt_http_check" CHECK (
    ("operation" = 'CREATE' AND "statusCode" = 201) OR
    ("operation" = 'UPDATE' AND "statusCode" = 200) OR
    ("operation" = 'DELETE' AND "statusCode" = 204 AND "responseBody" = 'null'::jsonb));
-- Positive versions, audit uniqueness, hash/key bounds and namespace PK stay intact.
-- O3b must introduce a tenant-qualified restrictive purchase-order supplier FK.
-- There is no order table/reference eligibility query in O3a.
