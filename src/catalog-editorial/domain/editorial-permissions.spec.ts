import { PERMISSION_REGISTRY } from '../../auth/authorization/domain/permission';
import {
  EDITORIAL_PERMISSIONS,
  isEditorialPermission,
} from './editorial-permissions';

describe('exact editorial permission identities', () => {
  it('registers exactly read/update/publish ProductEditorialDraft', () => {
    expect(EDITORIAL_PERMISSIONS).toEqual({
      read: { subject: 'ProductEditorialDraft', action: 'read' },
      update: { subject: 'ProductEditorialDraft', action: 'update' },
      publish: { subject: 'ProductEditorialDraft', action: 'publish' },
    });
    expect(PERMISSION_REGISTRY.filter(isEditorialPermission)).toEqual([
      expect.objectContaining(EDITORIAL_PERMISSIONS.read),
      expect.objectContaining(EDITORIAL_PERMISSIONS.update),
      expect.objectContaining({
        subject: 'ProductEditorialDraft',
        action: 'publish',
      }),
    ]);
    expect(
      PERMISSION_REGISTRY.filter((p) => p.subject === 'ProductEditorialDraft'),
    ).toHaveLength(3);
  });

  it.each(['read', 'update', 'publish'])(
    'recognizes exact %s identity',
    (action) => {
      expect(
        isEditorialPermission({ subject: 'ProductEditorialDraft', action }),
      ).toBe(true);
    },
  );

  it.each([
    ['all', 'manage'],
    ['Product', 'manage'],
    ['Product', 'read'],
    ['ProductEditorialDraft', 'manage'],
    ['ProductEditorialDraft', 'create'],
    ['ProductEditorialDraft', 'delete'],
    ['ProductEditorialDraft', 'batch_delete'],
    ['ProductEditorialDraft', 'READ'],
    ['productEditorialDraft', 'read'],
    ['TenantCatalogSettings', 'update'],
    ['SaleRefund', 'read'],
  ])('preserves unrelated %s:%s autogrants', (subject, action) => {
    expect(isEditorialPermission({ subject, action })).toBe(false);
  });
});
