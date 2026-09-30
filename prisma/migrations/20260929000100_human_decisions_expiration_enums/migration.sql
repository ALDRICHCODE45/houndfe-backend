-- human-decisions-expiration / HD-EXP-01 — enum additions for the EXPIRATION
-- decision type. Enum-only migration, and deliberately its own file: it must be
-- applied (and committed) BEFORE the persistence migration (20260929000200)
-- may reference the new members. PostgreSQL cannot use a value added by
-- `ALTER TYPE ... ADD VALUE` inside the same transaction that added it, so the
-- two migrations each carry their own explicit BEGIN;/COMMIT; — NOT a Git commit
-- boundary. If a single transaction wrapped both files, every CHECK below that
-- names 'EXPIRATION' would fail with "unsafe use of new value of enum type".
--
-- Additive and safe for populated databases: `ADD VALUE` appends the members in
-- the order written below and rewrites no existing row. No table is altered
-- here, and `HumanDecisionStatus`/`HumanDecisionBotOutcome` are untouched.
--
-- Approved design (read-only cross-repo source):
--   houndfe-chatbot-human-decisions/docs/human-decisions-contract-v1.md
--
-- Rollback (manual; only objects introduced by this migration): PostgreSQL has
-- no `DROP VALUE`, so the enum members cannot be removed in place. Roll back the
-- persistence migration first (20260929000200), then recreate each type without
-- the added member:
--   -- HumanDecisionType / HumanDecisionResolutionAction rebuilds omitted here;
--   -- see the persistence migration's rollback note for the drop-to-zero path.
BEGIN;

-- AlterEnum
-- Append-only: 'RESTOCK' stays first, so the existing column default and every
-- existing row keep their current value.
ALTER TYPE "HumanDecisionType" ADD VALUE 'EXPIRATION';

-- AlterEnum
-- EXPIRATION resolution actions. They are disjoint from the RESTOCK pair; the
-- persistence migration's resolution CHECK enforces type/action ownership.
ALTER TYPE "HumanDecisionResolutionAction" ADD VALUE 'PROVIDE_EXPIRATION_TEXT';

-- AlterEnum
ALTER TYPE "HumanDecisionResolutionAction" ADD VALUE 'REPORT_EXPIRATION_UNAVAILABLE';
COMMIT;
