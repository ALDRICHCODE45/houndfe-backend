-- CreateEnum
CREATE TYPE "EmployeeStatus" AS ENUM ('ACTIVE', 'ON_LEAVE', 'TERMINATED');

-- CreateEnum
CREATE TYPE "ContractType" AS ENUM ('PERMANENT', 'TEMPORARY', 'FREELANCE', 'INTERNSHIP');

-- CreateEnum
CREATE TYPE "WorkModality" AS ENUM ('ONSITE', 'REMOTE', 'HYBRID');

-- CreateEnum
CREATE TYPE "IdentityDocumentType" AS ENUM ('INE', 'PASSPORT', 'DRIVER_LICENSE', 'MILITARY_ID', 'OTHER');

-- CreateTable
CREATE TABLE "employees" (
    "id" TEXT NOT NULL,
    "employeeNumber" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "dateOfBirth" DATE,
    "nationalId" TEXT,
    "nationalIdType" "IdentityDocumentType",
    "photoFileId" TEXT,
    "cvFileId" TEXT,
    "street" TEXT,
    "exteriorNumber" TEXT,
    "interiorNumber" TEXT,
    "zipCode" TEXT,
    "neighborhood" TEXT,
    "municipality" TEXT,
    "city" TEXT,
    "state" TEXT,
    "hireDate" DATE NOT NULL,
    "terminationDate" DATE,
    "terminationReason" TEXT,
    "status" "EmployeeStatus" NOT NULL DEFAULT 'ACTIVE',
    "currentPosition" TEXT,
    "currentDepartment" TEXT,
    "currentSalaryCents" INTEGER,
    "currentSalaryCurrency" TEXT DEFAULT 'MXN',
    "currentResponsibilities" TEXT,
    "currentSchedule" TEXT,
    "contractType" "ContractType" NOT NULL DEFAULT 'PERMANENT',
    "workModality" "WorkModality" NOT NULL DEFAULT 'ONSITE',
    "annualVacationDays" INTEGER NOT NULL DEFAULT 0,
    "managerId" TEXT,
    "tenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employees_tenantId_terminationDate_idx" ON "employees"("tenantId", "terminationDate");

-- CreateIndex
CREATE INDEX "employees_tenantId_managerId_idx" ON "employees"("tenantId", "managerId");

-- CreateIndex
CREATE INDEX "employees_tenantId_status_idx" ON "employees"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "employees_tenantId_employeeNumber_key" ON "employees"("tenantId", "employeeNumber");

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
