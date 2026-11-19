-- cash-redesign-reads T5: the audit session list (GET /cash-sessions without
-- cashierUserId) orders by openedAt within the tenant; the existing
-- (tenantId, cashierUserId, openedAt) index cannot serve it.
CREATE INDEX "cash_sessions_tenantId_openedAt_idx" ON "cash_sessions"("tenantId", "openedAt");
