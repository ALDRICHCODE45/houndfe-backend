/**
 * The common route store copies the actor's name onto the request and its
 * events, so it uses the `actorDisplayName` fallback (trimmed name, email local
 * part, `Usuario`) for the claimer and for a reassign target. `User.name` can
 * be empty, and a request held by an empty name would read as held by nobody.
 */
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { PrismaChatbotRequestCommandStore } from '../infrastructure/prisma-chatbot-request-command.store';

function storeWith(db: {
  user?: { findUnique: jest.Mock };
  tenantMembership?: { findFirst: jest.Mock };
}) {
  const tenantPrisma = {
    getClient: () => db,
    getTenantId: () => 'tenant-1',
  } as unknown as TenantPrismaService;
  return new PrismaChatbotRequestCommandStore(tenantPrisma);
}

describe('PrismaChatbotRequestCommandStore actor names', () => {
  it.each([
    [{ name: 'Ana López', email: 'ana@x.mx' }, 'Ana López'],
    [{ name: '  Ana ', email: 'ana@x.mx' }, 'Ana'],
    [{ name: '', email: 'caja.noche@x.mx' }, 'caja.noche'],
    [{ name: '   ', email: 'caja.noche@x.mx' }, 'caja.noche'],
    [{ name: '', email: '@x.mx' }, 'Usuario'],
  ])('findActor copies the fallback for %j', async (user, expected) => {
    const findUnique = jest.fn().mockResolvedValue(user);
    const actor = await storeWith({ user: { findUnique } }).findActor('u-1');
    expect(actor).toEqual({ userId: 'u-1', displayName: expected });
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ select: { name: true, email: true } }),
    );
  });

  it('findActor answers null for an unknown user', async () => {
    const findUnique = jest.fn().mockResolvedValue(null);
    await expect(
      storeWith({ user: { findUnique } }).findActor('u-x'),
    ).resolves.toBeNull();
  });

  it('findAssignableUser copies the fallback for a target with an empty name', async () => {
    const findFirst = jest
      .fn()
      .mockResolvedValue({ user: { name: '', email: 'turno.tarde@x.mx' } });
    const target = await storeWith({
      tenantMembership: { findFirst },
    }).findAssignableUser('u-2');
    expect(target).toEqual({ userId: 'u-2', displayName: 'turno.tarde' });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: { user: { select: { name: true, email: true } } },
      }),
    );
  });
});
