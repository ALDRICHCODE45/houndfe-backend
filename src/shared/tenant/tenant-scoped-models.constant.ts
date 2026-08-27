export const TENANT_SCOPED_MODELS = new Set([
  'Product',
  'Variant',
  'Lot',
  'ProductImage',
  'FileObject',
  'PriceList',
  'TierPrice',
  'VariantPrice',
  'VariantTierPrice',
  'Order',
  'OrderItem',
  'Sale',
  'SaleItem',
  // Quotations (WU1) — five tables, one bounded context. Without these
  // entries, `findAll` / `findById` / `delete` would not auto-inject
  // tenantId into the WHERE clause and a cross-tenant row could leak.
  'Quotation',
  'QuotationItem',
  'QuotationPromotionVeto',
  'QuotationPromotionOptIn',
  'Customer',
  'CustomerAddress',
  'Promotion',
  'PromotionTargetItem',
  'PromotionCustomer',
  'PromotionPriceList',
  'PromotionDayOfWeek',
  'Role',
  'Employee',
  'EmployeeSalaryHistory',
  'EmployeePositionHistory',
  'EmployeeDocument',
  'EmployeeTimeOff',
  'EmployeeEmergencyContact',
  // Low-stock alerts (A.1) — allowlist-based; omitting ANY of these re-enables
  // cross-tenant reads via the tenant-id injection extension.
  'NotificationSettings',
  'NotificationRecipient',
  'NotificationAction',
  'StockAlertState',
  // PaymentDetail (Q1 / WU1) — bank account reference for the WhatsApp bot.
  // Tenant-scoped via CLS so cross-tenant reads auto-fail (404 surface) and
  // cross-tenant writes auto-insert the caller's tenantId.
  'PaymentDetail',
  // PaymentMethod (custom-payment-methods / WU1) — tenant-scoped tender-
  // method catalog. Silent allowlist — omitting this entry re-enables
  // cross-tenant reads via the TenantPrismaService WHERE-injection
  // extension. The defense-in-depth `where: { id, tenantId }` in the
  // Prisma adapter is the second layer; this allowlist is the first.
  'PaymentMethod',
      // delivery-routes / WU1 -- tenant-scoped bounded context that groups
      // eligible Sale rows into an ordered DeliveryRoute assigned to a driver
      // User. Without these allowlist entries the partial unique index on
      // (tenantId, saleId) WHERE activeRouteId IS NOT NULL (ADR-7) would
      // not be guarded by the runtime tenantId filter, and cross-tenant
      // read/write paths through TenantPrismaService would re-open.
      'DeliveryRoute',
      'DeliveryRouteStop',
]);