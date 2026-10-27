import { EditorialReaderAuthority } from './editorial-reader-authority';

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
};
const authority = new EditorialReaderAuthority(db);
beforeEach(() => {
  jest.clearAllMocks();
  db.user.findUnique.mockResolvedValue({ isActive: true });
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
it('rejects blank qualification before querying', async () => {
  expect(await authority.permits('actor', ' ')).toBe(false);
  expect(db.user.findUnique).not.toHaveBeenCalled();
});
