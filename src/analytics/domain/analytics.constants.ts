/**
 * Branch analytics summary — canonical business-day constants
 * (branch-analytics-summary / bas-2a).
 *
 * Declared in the domain layer so infrastructure adapters can derive raw-SQL
 * boundaries without importing a transport DTO. The query DTO re-exports it.
 */

/** Business timezone for every analytics business-day boundary. */
export const ANALYTICS_TIME_ZONE = 'America/Mexico_City';

/**
 * Seller sales report — canonical caps and discriminators
 * (seller-sales-report / v1).
 */

/** Combined confirmed+canceled row cap for one seller report. */
export const SELLER_SALES_REPORT_ROW_LIMIT = 1000;

/** Stable domain code for a combined row count above the report cap. */
export const SELLER_REPORT_ROW_LIMIT_EXCEEDED =
  'SELLER_REPORT_ROW_LIMIT_EXCEEDED';

/** Rows follow the sale's CURRENT seller, never a reconstructed historical one. */
export const SELLER_REPORT_ATTRIBUTION = 'CURRENT_SELLER';

/** Paid/debt figures are the CURRENT stored balances, not historical flows. */
export const SELLER_REPORT_BALANCES = 'CURRENT';
