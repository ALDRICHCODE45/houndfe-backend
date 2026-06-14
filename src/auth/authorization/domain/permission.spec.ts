import type { AppSubjects } from './permission';
import { PERMISSION_REGISTRY } from './permission';

describe('permission registry', () => {
  it('registers ReceiptEvidence as an application subject', () => {
    const subject: AppSubjects = 'ReceiptEvidence';

    expect(subject).toBe('ReceiptEvidence');
  });

  it('registers receipt evidence review permissions', () => {
    const receiptPermissions = PERMISSION_REGISTRY.filter(
      (permission) => permission.subject === 'ReceiptEvidence',
    ).map((permission) => permission.action);

    expect(receiptPermissions).toEqual(['read', 'update', 'manage']);
  });
});
