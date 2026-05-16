-- AlterTable
ALTER TABLE "sale_payments" ADD COLUMN "userId" TEXT;

-- CreateIndex
CREATE INDEX "sale_payments_userId_idx" ON "sale_payments"("userId");

-- AddForeignKey
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
