/**
 * Branch analytics summary — canonical business-day constants
 * (branch-analytics-summary / bas-2a).
 *
 * Declared in the domain layer so infrastructure adapters can derive raw-SQL
 * boundaries without importing a transport DTO. The query DTO re-exports it.
 */

/** Business timezone for every analytics business-day boundary. */
export const ANALYTICS_TIME_ZONE = 'America/Mexico_City';
