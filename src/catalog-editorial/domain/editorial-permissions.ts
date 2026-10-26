/** Exact row identities, not wildcard-expanded effective authorization. */
export const EDITORIAL_PERMISSIONS = {
  read: { subject: 'ProductEditorialDraft', action: 'read' },
  update: { subject: 'ProductEditorialDraft', action: 'update' },
} as const;

/** Provisioning exclusion only; does not revoke or grant runtime access. */
export function isEditorialPermission(permission: {
  subject: string;
  action: string;
}): boolean {
  return Object.values(EDITORIAL_PERMISSIONS).some(
    (identity) =>
      permission.subject === identity.subject &&
      permission.action === identity.action,
  );
}
