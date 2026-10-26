import { PrismaClient } from '@prisma/client';
import { emptyDocument } from '../domain/document';
import type { EditorialReadAuthority } from '../application/catalog-editorial-core';
import { PrismaCatalogEditorial } from './prisma-catalog-editorial';

const context = { actorId: 'actor', tenantId: 'tenant', productId: 'p' };
const granted = { ...context, activeMember: true, canRead: true };

describe('callable authorized editorial read', () => {
  const query = jest.fn();
  const client = {
    $transaction: (work: (tx: unknown) => Promise<unknown>) =>
      work({ $queryRaw: query }),
  } as unknown as PrismaClient;
  beforeEach(() => query.mockReset());
  it.each([
    null,
    { ...granted, activeMember: false },
    { ...granted, canRead: false },
    { ...granted, actorId: 'other' },
    { ...granted, tenantId: 'other' },
    { ...granted, productId: 'other' },
  ])('fails closed before lookup for authority %j', async (snapshot) => {
    const core = new PrismaCatalogEditorial(client, {
      resolve: () => Promise.resolve(snapshot),
    });
    await expect(core.read(context)).rejects.toThrow('FORBIDDEN');
    expect(query).not.toHaveBeenCalled();
  });
  it('create fails closed without an explicit create authority', async () => {
    const core = new PrismaCatalogEditorial(client, {
      resolve: () => Promise.resolve(granted),
    });
    await expect(
      core.create(context, {
        expectedCycle: null,
        idempotencyKey: 'k',
        document: emptyDocument(),
      }),
    ).rejects.toThrow('FORBIDDEN');
    expect(query).not.toHaveBeenCalled();
  });
  it('fails closed when the authority is unavailable', async () => {
    const authority: EditorialReadAuthority = {
      resolve: () => Promise.reject(new Error('unavailable')),
    };
    await expect(
      new PrismaCatalogEditorial(client, authority).read(context),
    ).rejects.toThrow('FORBIDDEN');
    expect(query).not.toHaveBeenCalled();
  });
  it('does not expose state without a tenant-qualified Product', async () => {
    query.mockResolvedValueOnce([]);
    const core = new PrismaCatalogEditorial(client, {
      resolve: () => Promise.resolve(granted),
    });
    await expect(core.read(context)).rejects.toThrow('NOT_FOUND');
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('returns an absent lifecycle without creating state', async () => {
    query.mockResolvedValueOnce([{ id: 'p' }]).mockResolvedValueOnce([]);
    const core = new PrismaCatalogEditorial(client, {
      resolve: () => Promise.resolve(granted),
    });
    await expect(core.read(context)).resolves.toEqual({
      cycle: null,
      draft: null,
      published: null,
    });
    expect(query).toHaveBeenCalledTimes(2);
  });
});
