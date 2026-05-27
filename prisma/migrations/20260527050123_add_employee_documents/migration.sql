-- CreateEnum
CREATE TYPE "EmployeeDocumentCategory" AS ENUM ('CONTRACT', 'NDA', 'EVALUATION', 'CERTIFICATE', 'WARNING', 'ID_DOCUMENT', 'CV', 'MEDICAL', 'OTHER');

-- CreateTable
CREATE TABLE "employee_documents" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "category" "EmployeeDocumentCategory" NOT NULL,
    "expiresAt" DATE,
    "notes" TEXT,
    "uploadedByUserId" TEXT,
    "tenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_documents_employeeId_category_idx" ON "employee_documents"("employeeId", "category");

-- CreateIndex
CREATE INDEX "employee_documents_employeeId_expiresAt_idx" ON "employee_documents"("employeeId", "expiresAt");

-- CreateIndex
CREATE INDEX "employee_documents_tenantId_expiresAt_idx" ON "employee_documents"("tenantId", "expiresAt");

-- AddForeignKey
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
