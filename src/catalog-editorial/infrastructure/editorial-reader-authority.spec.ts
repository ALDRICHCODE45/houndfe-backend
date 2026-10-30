import type { PrismaClient } from '@prisma/client';
import { EditorialReaderAuthority } from './editorial-reader-authority';
import { PrismaEditorialAuthority } from './prisma-editorial-authority';

const member = (userId = 'actor', tenantId = 'tenant') => ({
  userId,
  tenantId,
  role: {
    permissions: [
      { permission: { subject: 'ProductEditorialDraft', action: 'read' } },
    ],
  },
});
const db = {
  user: { findUnique: jest.fn() },
  tenantMembership: { findMany: jest.fn() },
  role: { findFirst: jest.fn() },
  product: { findFirst: jest.fn() },
};
const authority = new EditorialReaderAuthority(db as unknown as PrismaClient);
beforeEach(() => {
  jest.clearAllMocks();
  db.user.findUnique.mockResolvedValue({ isActive: true });
  db.role.findFirst.mockReset().mockResolvedValue(null);
  db.product.findFirst
    .mockReset()
    .mockResolvedValue({ id: 'product', tenantId: 'tenant' });
});
it('permits an exact current grant without any product dependency', async () => {
  db.tenantMembership.findMany.mockResolvedValue([member()]);
  expect(await authority.permits('actor', 'tenant')).toBe(true);
  expect(db.user.findUnique).toHaveBeenCalledWith({
    where: { id: 'actor' },
    select: { isActive: true },
  });
});
it.each([
  [],
  [member('foreign')],
  [member('actor', 'foreign')],
  [member(), member('foreign')],
])('fails closed for memberships %p', async (...memberships) => {
  db.tenantMembership.findMany.mockResolvedValue(memberships);
  expect(await authority.permits('actor', 'tenant')).toBe(false);
});
it('fails closed on membership outage', async () => {
  db.tenantMembership.findMany.mockRejectedValue(new Error('private failure'));
  expect(await authority.permits('actor', 'tenant')).toBe(false);
});
describe.each(['reader', 'product'] as const)(
  '%s administrator policy',
  (kind) => {
    const scope = {
      actorId: 'actor',
      tenantId: 'tenant',
      productId: 'product',
    };
    const resolve = () =>
      kind === 'reader'
        ? authority.permits(scope.actorId, scope.tenantId)
        : new PrismaEditorialAuthority(db as unknown as PrismaClient).resolve(
            scope,
          );
    const allowed = async () => {
      const result = await resolve();
      return typeof result === 'boolean' ? result : result?.canRead === true;
    };
    const globalQuery = {
      where: {
        tenantId: null,
        tenantMemberships: { some: { userId: 'actor' } },
        OR: [
          { isSystem: true, name: 'Super Admin' },
          {
            permissions: {
              some: { permission: { subject: 'all', action: 'manage' } },
            },
          },
        ],
      },
      select: { id: true },
    };
    it.each(['system', 'wildcard'])(
      'accepts current global %s proof and rechecks revocation',
      async (identity) => {
        db.tenantMembership.findMany.mockResolvedValue([]);
        db.role.findFirst.mockImplementation((query: unknown) => {
          expect(query).toEqual(globalQuery);
          return Promise.resolve({ id: identity });
        });
        expect(await allowed()).toBe(true);
        expect(db.role.findFirst).toHaveBeenCalledWith(globalQuery);
        if (kind === 'product') {
          expect(await resolve()).toMatchObject({
            activeMember: true,
            canCreate: true,
            canSave: true,
            canDiscard: true,
            canPublish: true,
          });
          expect(db.product.findFirst).toHaveBeenCalledWith({
            where: { id: 'product', tenantId: 'tenant' },
            select: { id: true, tenantId: true },
          });
          db.product.findFirst.mockResolvedValue({
            id: 'product',
            tenantId: 'foreign',
          });
          expect(await allowed()).toBe(false);
          db.product.findFirst.mockResolvedValue({
            id: 'product',
            tenantId: 'tenant',
          });
        }
        db.role.findFirst.mockResolvedValue(null);
        expect(await allowed()).toBe(false);
      },
    );
    it.each([
      'inactive',
      'missing',
      'outage',
      'lookalike',
      'foreign-wildcard',
      'foreign-actor',
    ])('denies %s despite caller claims', async (reason) => {
      db.tenantMembership.findMany.mockResolvedValue([]);
      if (reason === 'inactive') {
        db.user.findUnique.mockResolvedValue({ isActive: false });
        db.role.findFirst.mockResolvedValue({ id: 'global-role' });
      }
      if (reason === 'outage')
        db.role.findFirst.mockRejectedValue(new Error('offline'));
      if (reason === 'lookalike')
        db.tenantMembership.findMany.mockResolvedValue([
          {
            ...member(),
            role: { name: 'Super Admin', isSystem: true, permissions: [] },
          },
        ]);
      if (reason.startsWith('foreign-'))
        db.tenantMembership.findMany.mockResolvedValue([
          {
            ...member(
              reason === 'foreign-actor' ? 'foreign' : 'actor',
              reason === 'foreign-wildcard' ? 'foreign' : 'tenant',
            ),
            role: {
              permissions: [
                { permission: { subject: 'all', action: 'manage' } },
              ],
            },
          },
        ]);
      expect(await allowed()).toBe(false);
      const productAuthority = new PrismaEditorialAuthority(
        db as unknown as PrismaClient,
      );
      const spoofed = await productAuthority.resolve({
        ...scope,
        isSuperAdmin: true,
      } as typeof scope);
      expect(spoofed?.canRead === true).toBe(false);
    });
    it('accepts only qualified tenant wildcard without global proof', async () => {
      db.tenantMembership.findMany.mockResolvedValue([
        {
          ...member(),
          role: {
            permissions: [{ permission: { subject: 'all', action: 'manage' } }],
          },
        },
      ]);
      expect(await allowed()).toBe(true);
      expect(db.tenantMembership.findMany).toHaveBeenCalledWith({
        where: { userId: 'actor', tenantId: 'tenant' },
        include: {
          role: { include: { permissions: { include: { permission: true } } } },
        },
      });
    });
  },
);
it('rejects blank qualification before querying', async () => {
  expect(await authority.permits('actor', ' ')).toBe(false);
  expect(db.user.findUnique).not.toHaveBeenCalled();
});
