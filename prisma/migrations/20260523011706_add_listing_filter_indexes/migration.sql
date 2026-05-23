-- CreateIndex
CREATE INDEX "idx_sale_payments_tenant_method" ON "sale_payments"("tenantId", "method");

-- CreateIndex
CREATE INDEX "idx_sales_tenant_status_confirmedAt_desc" ON "sales"("tenantId", "status", "confirmedAt" DESC);
