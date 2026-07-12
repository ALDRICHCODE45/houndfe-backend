-- AlterEnum
--
-- Standalone migration: must NOT have a same-transaction consumer
-- (Postgres restriction — `ALTER TYPE ... ADD VALUE` cannot run in the
-- same transaction that uses the new value). The consuming code lives
-- in subsequent migrations / deploys, so this file is intentionally
-- minimal.
ALTER TYPE "PromotionTargetType" ADD VALUE 'VARIANTS';