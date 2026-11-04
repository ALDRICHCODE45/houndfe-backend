-- Additive confirm/cancel storage. Existing rows are all DRAFT and keep every new column NULL.
-- No stock, reservation, money, debt or outbox structures; actor ids are deliberately not stored.
ALTER TABLE "procurement_purchase_orders"
  ADD COLUMN "confirmedAt" TIMESTAMP(3),
  ADD COLUMN "confirmedByDisplayName" TEXT,
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "cancelledByDisplayName" TEXT,
  ADD COLUMN "lineSubtotalsSnapshot" JSONB;

ALTER TABLE "procurement_purchase_orders"
  ADD CONSTRAINT "po_status_transition_check" CHECK (
    ("status" = 'DRAFT' AND "confirmedAt" IS NULL AND "confirmedByDisplayName" IS NULL
      AND "cancelledAt" IS NULL AND "cancelledByDisplayName" IS NULL)
    OR ("status" = 'CONFIRMED' AND "confirmedAt" IS NOT NULL AND "confirmedByDisplayName" IS NOT NULL
      AND "cancelledAt" IS NULL AND "cancelledByDisplayName" IS NULL)
    OR ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL AND "cancelledByDisplayName" IS NOT NULL
      AND (("confirmedAt" IS NULL AND "confirmedByDisplayName" IS NULL)
        OR ("confirmedAt" IS NOT NULL AND "confirmedByDisplayName" IS NOT NULL)))),
  ADD CONSTRAINT "po_frozen_subtotals_check" CHECK (
    ("status" = 'DRAFT' AND "lineSubtotalsSnapshot" IS NULL)
    OR ("status" = 'CONFIRMED' AND "lineSubtotalsSnapshot" IS NOT NULL AND jsonb_typeof("lineSubtotalsSnapshot") = 'array')
    OR ("status" = 'CANCELLED' AND ("lineSubtotalsSnapshot" IS NULL OR jsonb_typeof("lineSubtotalsSnapshot") = 'array')));

-- Widen evidence checks for the new operations; CREATE/REPLACE/DELETE rules stay identical.
ALTER TABLE "procurement_purchase_order_audits"
  DROP CONSTRAINT "po_audit_snapshots_check";
ALTER TABLE "procurement_purchase_order_audits"
  ADD CONSTRAINT "po_audit_snapshots_check" CHECK (
    ("operation" = 'CREATE' AND "beforeSnapshot" IS NULL AND "afterSnapshot" IS NOT NULL AND jsonb_typeof("afterSnapshot") = 'object') OR
    ("operation" = 'REPLACE' AND "beforeSnapshot" IS NOT NULL AND jsonb_typeof("beforeSnapshot") = 'object' AND "afterSnapshot" IS NOT NULL AND jsonb_typeof("afterSnapshot") = 'object') OR
    ("operation" = 'DELETE' AND "beforeSnapshot" IS NOT NULL AND jsonb_typeof("beforeSnapshot") = 'object' AND "afterSnapshot" IS NULL) OR
    ("operation" IN ('CONFIRM', 'CANCEL') AND "beforeSnapshot" IS NOT NULL AND jsonb_typeof("beforeSnapshot") = 'object' AND "afterSnapshot" IS NOT NULL AND jsonb_typeof("afterSnapshot") = 'object'));

ALTER TABLE "procurement_purchase_order_receipts"
  DROP CONSTRAINT "po_receipt_namespace_check",
  DROP CONSTRAINT "po_receipt_http_check";
ALTER TABLE "procurement_purchase_order_receipts"
  ADD CONSTRAINT "po_receipt_namespace_check" CHECK (
    ("operation" = 'CREATE' AND "target" = 'collection') OR
    ("operation" IN ('REPLACE', 'DELETE', 'CONFIRM', 'CANCEL') AND "target" = "orderId")),
  ADD CONSTRAINT "po_receipt_http_check" CHECK (
    ("operation" = 'CREATE' AND "statusCode" = 201) OR
    ("operation" IN ('REPLACE', 'CONFIRM', 'CANCEL') AND "statusCode" = 200) OR
    ("operation" = 'DELETE' AND "statusCode" = 204 AND "responseBody" = 'null'::jsonb));
