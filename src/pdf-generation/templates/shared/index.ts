/**
 * Barrel export for the shared receipt blocks.
 *
 * WU3 templates (`receipt-a4.document.tsx`, `receipt-ticket.document.tsx`)
 * import everything from this module so they can stay agnostic about
 * the on-disk layout of the shared blocks. Adding a new shared
 * component (e.g. a `NotesSection`) is a one-line change here plus
 * the new file.
 *
 * Type exports come BEFORE component exports so consumers can
 * `import { TotalsBlock, type TotalsBlockProps }` in a single line.
 */
export type { ReceiptHeaderProps } from './receipt-header';
export { ReceiptHeader } from './receipt-header';

export type { LineItem, LineItemsTableProps } from './line-items-table';
export { LineItemsTable } from './line-items-table';

export type { TotalsBlockProps } from './totals-block';
export { TotalsBlock } from './totals-block';

export type { Payment, PaymentsListProps } from './payments-list';
export { PaymentsList } from './payments-list';

export type { CustomerSectionProps } from './customer-section';
export {
  CustomerSection,
  PUBLIC_CUSTOMER_PLACEHOLDER,
} from './customer-section';

export { SHARED_STYLES } from './styles';