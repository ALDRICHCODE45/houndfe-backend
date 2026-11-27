/**
 * customers-bulk-actions — public surface of the bulk selection for other
 * modules (the bulk statements, T3). Import `CustomersModule` to inject
 * `CustomerBulkSelectionResolver`.
 */
export {
  CustomerBulkSelectionDto,
  CustomerBulkSelectionMode,
  MAX_BULK_SELECTION_IDS,
} from './customer-bulk-selection.dto';
export {
  CustomerBulkSelectionResolver,
  type CustomerBulkSelectionOptions,
  type ResolvedCustomerSelection,
} from './customer-bulk-selection.resolver';
export {
  CustomerBulkErrorCode,
  bulkCustomersNotFound,
  bulkSelectionEmpty,
  bulkSelectionTooLarge,
} from './customer-bulk.errors';
export { holdsCustomerExportPermission } from './customer-export.permission';
