import type { PrismaClient } from '@prisma/client';
import { PrivateMediaAccess } from './private-media-access';
import { PrismaEditorialAuthority } from '../../catalog-editorial/infrastructure/prisma-editorial-authority';
const context = { actorId: 'user', tenantId: 'tenant', productId: 'product' };
const user = { findUnique: jest.fn() };
const tenantMembership = { findMany: jest.fn() };
const product = { findFirst: jest.fn() };
const access = new PrivateMediaAccess({
  user,
  tenantMembership,
  product,
} as unknown as PrismaClient);
function permissions(actions: string[], subject = 'ProductEditorialDraft') {
  return [
    {
      userId: 'user',
      tenantId: 'tenant',
      role: {
        name: 'admin',
        permissions: actions.map((action) => ({
          permission: { subject, action },
        })),
      },
    },
  ];
}
beforeEach(() => {
  jest.restoreAllMocks();
  user.findUnique.mockReset().mockResolvedValue({ isActive: true });
  tenantMembership.findMany
    .mockReset()
    .mockResolvedValue(permissions(['read', 'update']));
  product.findFirst
    .mockReset()
    .mockResolvedValue({ id: 'product', tenantId: 'tenant' });
});
test('actual current authority permits upload/read and observes revocation', async () => {
  expect(await access.canUpload(context)).toBe(true);
  expect(await access.canRead(context)).toBe(true);
  tenantMembership.findMany.mockResolvedValue([]);
  expect(await access.canRead(context)).toBe(false);
  expect(await access.canUpload(context)).toBe(false);
  expect(user.findUnique).toHaveBeenCalledTimes(4);
});
test.each([
  [['read'], 'ProductEditorialDraft', false, true],
  [['update'], 'ProductEditorialDraft', false, false],
  [['manage', '*'], 'all', false, false],
  [[], 'ProductEditorialDraft', false, false],
] as const)(
  'exact permissions %p on %s',
  async (actions, subject, upload, read) => {
    tenantMembership.findMany.mockResolvedValue(
      permissions([...actions], subject),
    );
    expect(await access.canUpload(context)).toBe(upload);
    expect(await access.canRead(context)).toBe(read);
  },
);
test.each([
  'inactive',
  'missing-member',
  'foreign-member',
  'foreign-product',
  'foreign-product-id',
  'failure',
])('denies %s', async (condition) => {
  if (condition === 'inactive')
    user.findUnique.mockResolvedValue({ isActive: false });
  if (condition === 'missing-member')
    tenantMembership.findMany.mockResolvedValue([]);
  if (condition === 'foreign-member')
    tenantMembership.findMany.mockResolvedValue([
      { ...permissions([])[0], tenantId: 'other' },
    ]);
  if (condition === 'foreign-product')
    product.findFirst.mockResolvedValue({ id: 'product', tenantId: 'other' });
  if (condition === 'foreign-product-id')
    product.findFirst.mockResolvedValue({ id: 'other', tenantId: 'tenant' });
  if (condition === 'failure')
    user.findUnique.mockRejectedValue(new Error('offline'));
  expect(await access.canUpload(context)).toBe(false);
  expect(await access.canRead(context)).toBe(false);
});
test.each(['actorId', 'tenantId', 'productId'] as const)(
  'invalid %s denies before dependencies',
  async (field) => {
    expect(await access.canUpload({ ...context, [field]: '' })).toBe(false);
    expect(await access.canRead(null as never)).toBe(false);
    expect(user.findUnique).not.toHaveBeenCalled();
  },
);
test.each(['actorId', 'tenantId', 'productId'] as const)(
  'rejects mismatched snapshot %s despite capability flags',
  async (field) => {
    jest
      .spyOn(PrismaEditorialAuthority.prototype, 'resolve')
      .mockResolvedValue({
        ...context,
        [field]: 'other',
        activeMember: true,
        canRead: true,
        canSave: true,
        canCreate: true,
      });
    expect(await access.canUpload(context)).toBe(false);
    expect(await access.canRead(context)).toBe(false);
  },
);
test('resolver rejection denies both operations', async () => {
  jest
    .spyOn(PrismaEditorialAuthority.prototype, 'resolve')
    .mockRejectedValue(new Error('unavailable'));
  expect(await access.canUpload(context)).toBe(false);
  expect(await access.canRead(context)).toBe(false);
});
