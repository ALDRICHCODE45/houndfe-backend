-- Commit the enum additions before the next migration uses their values.
ALTER TYPE "ProcurementPurchaseOrderStatus" ADD VALUE 'CONFIRMED';
ALTER TYPE "ProcurementPurchaseOrderStatus" ADD VALUE 'CANCELLED';
ALTER TYPE "ProcurementPurchaseOrderOperation" ADD VALUE 'CONFIRM';
ALTER TYPE "ProcurementPurchaseOrderOperation" ADD VALUE 'CANCEL';
