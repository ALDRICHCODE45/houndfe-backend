-- Public catalog v0 (S3). Additive.
--   CatalogStockPresentation gains SYSTEM_STATUS_EXACT_LOW_STOCK: the opt-in
--   mode where a low_stock row also carries its real quantity. No column
--   default changes, so every existing tenant, product and variant keeps its
--   current mode.
--
-- ADD VALUE only takes a short lock on the enum type; lock_timeout makes it
-- fail fast instead of queueing behind a long transaction that uses the type.
-- The new value is not used in this migration (PostgreSQL forbids that inside
-- the same transaction).
--
-- Rollback: PostgreSQL cannot remove an enum value in place, so there is no
-- automatic down-migration. The value stays inert unless a tenant, product or
-- variant selects it, and rows that did would need to be moved to another mode
-- before recreating the type.
SET LOCAL lock_timeout = '5s';

ALTER TYPE "CatalogStockPresentation" ADD VALUE IF NOT EXISTS 'SYSTEM_STATUS_EXACT_LOW_STOCK';
