import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PERMISSION_REGISTRY } from '../../auth/authorization/domain/permission';

describe('purchase-order permission registry', () => {
  it('adds exactly four granular permissions without changing existing permissions', () => {
    const orders = PERMISSION_REGISTRY.filter(
      (p) => String(p.subject) === 'ProcurementPurchaseOrder',
    );
    expect(orders.map((p) => p.action).sort()).toEqual([
      'create',
      'delete',
      'read',
      'update',
    ]);
    const prior = PERMISSION_REGISTRY.filter(
      (p) =>
        ![
          'ProcurementSupplier',
          'ProcurementPurchaseOrder',
          'ProcurementOrderConfirmation',
          'ProcurementOrderCancellation',
        ].includes(p.subject),
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

  it.each([
    ['ProcurementOrderConfirmation', 'Confirm purchase orders'],
    ['ProcurementOrderCancellation', 'Cancel purchase orders'],
  ])(
    'adds configurable %s with only the create action',
    (subject, description) => {
      expect(
        PERMISSION_REGISTRY.filter((p) => String(p.subject) === subject),
      ).toEqual([{ subject, action: 'create', description }]);
    },
  );

  it('keeps the purchase-order read permission that confirm and cancel also require', () => {
    expect(PERMISSION_REGISTRY).toContainEqual(
      expect.objectContaining({
        subject: 'ProcurementPurchaseOrder',
        action: 'read',
      }),
    );
  });

  it.each(['manager', 'cashier'])(
    'does not grant PO permissions to the %s dev-seed role',
    (role) => {
      const seed = readFileSync(join(process.cwd(), 'prisma/seed.ts'), 'utf8');
      const keys = seed.match(
        new RegExp(
          `const ${role}PermissionKeys: SeedPermissionKey\\[\\] = \\[([\\s\\S]*?)\\];`,
        ),
      );
      expect(keys).not.toBeNull();
      expect(keys![1]).not.toContain('ProcurementPurchaseOrder');
      expect(keys![1]).not.toContain('ProcurementOrderConfirmation');
      expect(keys![1]).not.toContain('ProcurementOrderCancellation');
    },
  );

  it('production bootstrap links only the existing manage:all permission', () => {
    const seed = readFileSync(
      join(
        process.cwd(),
        'src/auth/authorization/infrastructure/permission.seeder.ts',
      ),
      'utf8',
    );
    expect(seed).not.toContain('ProcurementPurchaseOrder');
    expect(seed).not.toContain('ProcurementOrder');
    expect(seed).toContain("p.subject === 'all' && p.action === 'manage'");
    expect(seed.match(/rolePermission\.upsert/g)).toHaveLength(1);
    expect(seed).toContain('permissionId: manageAllPermission.id');
  });
});
