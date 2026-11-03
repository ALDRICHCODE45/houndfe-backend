-- Commit the enum addition before the next migration uses its value.
ALTER TYPE "ProcurementSupplierOperation" ADD VALUE 'DELETE';
