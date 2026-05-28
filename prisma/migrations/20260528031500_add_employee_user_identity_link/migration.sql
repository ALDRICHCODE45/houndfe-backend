-- Add an optional tenant-scoped identity link from employees to users.
ALTER TABLE "employees" ADD COLUMN "userId" TEXT;

ALTER TABLE "employees"
  ADD CONSTRAINT "employees_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "employees_tenantId_userId_key" ON "employees"("tenantId", "userId");
