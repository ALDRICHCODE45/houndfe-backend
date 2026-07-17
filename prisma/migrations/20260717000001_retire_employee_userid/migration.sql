-- Slice 2 / WU2 — destructive migration for the Employee.userId retirement.
--
-- The previous identity link (added in 20260528031500) is removed here.
-- The migration touches ONLY the `employees` table:
--   - DROP CONSTRAINT employees_userId_fkey
--   - DROP INDEX      employees_tenantId_userId_key
--   - DROP COLUMN     "userId"
--
-- Reverse of 20260528031500_add_employee_user_identity_link.
-- Order matters: the constraint + index must be dropped BEFORE the
-- column so PG doesn't reject the column drop with dependency errors.
ALTER TABLE "employees" DROP CONSTRAINT "employees_userId_fkey";

DROP INDEX "employees_tenantId_userId_key";

ALTER TABLE "employees" DROP COLUMN "userId";