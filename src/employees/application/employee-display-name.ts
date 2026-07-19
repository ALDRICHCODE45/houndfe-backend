/**
 * Build a human-readable display name from an employee's first and last name.
 *
 * Single source of truth for the identity label surfaced across HR endpoints
 * (time-off request outbox payloads, tenant-wide pending-approvals, expiring
 * documents). Preserves the Spanish-neutral `'(empleado)'` fallback used by the
 * domain when no usable name parts are present.
 */
export function buildDisplayName(
  firstName?: string | null,
  lastName?: string | null,
): string {
  return [firstName, lastName].filter(Boolean).join(' ').trim() || '(empleado)';
}
