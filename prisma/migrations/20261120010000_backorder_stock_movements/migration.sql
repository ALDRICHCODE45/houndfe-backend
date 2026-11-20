-- restock-backorder / T2a — journal vocabulary for backorder reservations
-- (contract v1 §3): a RESERVED backorder takes its units out of the sellable
-- buckets with a BACKORDER_RESERVE movement and hands them back with a
-- BACKORDER_RELEASE movement, both grouped as groupType BACKORDER with
-- groupId = backorderId.
--
-- Additive only and hand-written: three enum values, no table, column, index,
-- constraint or data change. The new values are NOT used in this migration
-- (PostgreSQL forbids using a value added inside the same transaction); the
-- application starts writing them only after the deploy has applied it.
-- `IF NOT EXISTS` keeps a re-run harmless. lock_timeout makes ADD VALUE fail
-- fast instead of queueing behind a long transaction that uses the type.
--
-- Rollback: PostgreSQL cannot remove an enum value in place, so there is no
-- automatic down-migration. The values stay inert unless a backorder
-- reservation writes them; if the feature is reverted, rows that used them
-- must be moved to another type before the types could be recreated.
SET LOCAL lock_timeout = '5s';

ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'BACKORDER_RESERVE';
ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'BACKORDER_RELEASE';
ALTER TYPE "StockMovementGroupType" ADD VALUE IF NOT EXISTS 'BACKORDER';
