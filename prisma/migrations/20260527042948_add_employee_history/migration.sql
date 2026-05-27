-- CreateTable
CREATE TABLE "employee_salary_history" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MXN',
    "effectiveFrom" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "recordedByUserId" TEXT,
    "tenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_salary_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_position_history" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "position" TEXT NOT NULL,
    "department" TEXT,
    "effectiveFrom" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "recordedByUserId" TEXT,
    "tenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_position_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_salary_history_employeeId_effectiveFrom_idx" ON "employee_salary_history"("employeeId", "effectiveFrom" DESC);

-- CreateIndex
CREATE INDEX "employee_salary_history_tenantId_employeeId_idx" ON "employee_salary_history"("tenantId", "employeeId");

-- CreateIndex
CREATE INDEX "employee_position_history_employeeId_effectiveFrom_idx" ON "employee_position_history"("employeeId", "effectiveFrom" DESC);

-- CreateIndex
CREATE INDEX "employee_position_history_tenantId_employeeId_idx" ON "employee_position_history"("tenantId", "employeeId");

-- AddForeignKey
ALTER TABLE "employee_salary_history" ADD CONSTRAINT "employee_salary_history_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_salary_history" ADD CONSTRAINT "employee_salary_history_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_position_history" ADD CONSTRAINT "employee_position_history_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_position_history" ADD CONSTRAINT "employee_position_history_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
