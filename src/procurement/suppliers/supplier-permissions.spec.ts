import { createHash } from 'node:crypto';
import { PERMISSION_REGISTRY } from '../../auth/authorization/domain/permission';

describe('supplier permission registry', () => {
  it('adds exactly create/read/update/delete, without changing prior permissions', () => {
    const suppliers = PERMISSION_REGISTRY.filter(
      (p) => String(p.subject) === 'ProcurementSupplier',
    );
    expect(suppliers.map((p) => p.action).sort()).toEqual([
      'create',
      'delete',
      'read',
      'update',
    ]);
  });
  it('preserves every existing permission and manage:all behavior', () => {
    const prior = PERMISSION_REGISTRY.filter(
      (p) =>
        String(p.subject) !== 'ProcurementSupplier' &&
        String(p.subject) !== 'ProcurementPurchaseOrder' &&
        String(p.subject) !== 'ProcurementOrderConfirmation' &&
        String(p.subject) !== 'ProcurementOrderCancellation' &&
        String(p.subject) !== 'InventoryJournal' &&
        String(p.subject) !== 'InventoryAdjustment',
    );
    expect(
      createHash('sha256').update(JSON.stringify(prior)).digest('hex'),
    ).toBe('9928ce0318212909e672e29f43452e504be8425e157fcd6cd11add1584174387');
    expect(prior).toContainEqual({
      subject: 'all',
      action: 'manage',
      description: 'Full system access',
    });
  });
});
