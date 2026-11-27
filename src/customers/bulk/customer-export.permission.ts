/**
 * customers-bulk-actions / T1 (S2, owner L3) — `export:Customer` is a SPECIAL
 * permission: «exportar datos de clientes debe ser un permiso nuevo especial».
 *
 * CASL's `manage` is a wildcard, so `ability.can('export', 'Customer')` is
 * also true for a role holding `manage:Customer` («Full customer
 * management»). Like `batch_delete` (`BatchDeleteGuard`), the export needs the
 * EXPLICIT row; the super admin's `manage:all` is the only wildcard accepted.
 * Reads the raw rules of the ability `PermissionsGuard` already built, so no
 * extra query.
 */
import type { AppAbility } from '../../auth/authorization/domain/permission';

const toArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [value];

export function holdsCustomerExportPermission(
  ability: Pick<AppAbility, 'rules'>,
): boolean {
  return ability.rules.some((rule) => {
    if (rule.inverted) return false;
    const actions = toArray(rule.action);
    const subjects = toArray(rule.subject);
    return (
      (actions.includes('export') && subjects.includes('Customer')) ||
      (actions.includes('manage') && subjects.includes('all'))
    );
  });
}
