/* eslint-disable @typescript-eslint/require-await -- Async Prisma mock boundary. */
import type { Prisma } from '@prisma/client';
import { requireInventoryAuthority } from './inventory-authority';
import { inventoryErrorEnvelope } from './inventory-contract';

const scope = { tenantId: 'tenant', actorId: 'actor' };
const journalRead = { action: 'read', subject: 'InventoryJournal' };
const adjustmentCreate = { action: 'create', subject: 'InventoryAdjustment' };

function tx(user: object[], grants: object[]) {
  const query = jest.fn(async (sql: Prisma.Sql) =>
    sql.sql.includes('FROM "users"') ? user : grants,
  );
  // SAFETY: authority uses only this query interface on its caller's transaction.
  return {
    client: { $queryRaw: query } as unknown as Prisma.TransactionClient,
    query,
  };
}
const active = [{ id: scope.actorId, isActive: true, name: 'Ana Pérez' }];
const code = async (work: Promise<unknown>) =>
  inventoryErrorEnvelope(await work.catch((failure: unknown) => failure));

describe('inventory current persisted authority', () => {
  it('READ needs only journal read, locks the grant edges and returns users.name', async () => {
    const { client, query } = tx(active, [journalRead]);
    await expect(
      requireInventoryAuthority(client, scope, 'READ'),
    ).resolves.toEqual({ displayName: 'Ana Pérez' });
    expect(query.mock.calls[0][0].sql).toContain('FOR SHARE OF u');
    expect(query.mock.calls[1][0].sql).toContain('FOR SHARE OF m, r, rp, p');
    expect(query.mock.calls[1][0].values).toEqual([
      scope.tenantId,
      scope.actorId,
    ]);
  });

  it('ADJUST needs adjustment create plus journal read (no inheritance from Product/Sale)', async () => {
    await expect(
      requireInventoryAuthority(
        tx(active, [journalRead, adjustmentCreate]).client,
        scope,
        'ADJUST',
      ),
    ).resolves.toEqual({ displayName: 'Ana Pérez' });
    for (const grants of [
      [journalRead],
      [adjustmentCreate],
      [
        { action: 'manage', subject: 'Product' },
        { action: 'create', subject: 'Sale' },
        { action: 'update', subject: 'Product' },
      ],
      [],
    ])
      expect(
        await code(
          requireInventoryAuthority(tx(active, grants).client, scope, 'ADJUST'),
        ),
      ).toEqual({ statusCode: 403, error: 'FORBIDDEN' });
  });

  it('READ is not satisfied by the adjustment grant alone', async () => {
    expect(
      await code(
        requireInventoryAuthority(
          tx(active, [adjustmentCreate]).client,
          scope,
          'READ',
        ),
      ),
    ).toEqual({ statusCode: 403, error: 'FORBIDDEN' });
  });

  it('full-access (manage all) satisfies both operations', async () => {
    const all = [{ action: 'manage', subject: 'all' }];
    await requireInventoryAuthority(tx(active, all).client, scope, 'READ');
    await requireInventoryAuthority(tx(active, all).client, scope, 'ADJUST');
  });

  it.each(['missing', 'inactive', 'wrongActor'])(
    'rejects %s user with 401 before reading grants',
    async (kind) => {
      const user =
        kind === 'missing'
          ? []
          : [
              {
                id: kind === 'wrongActor' ? 'other' : scope.actorId,
                isActive: kind !== 'inactive',
                name: 'x',
              },
            ];
      const { client, query } = tx(user, [journalRead]);
      expect(
        await code(requireInventoryAuthority(client, scope, 'READ')),
      ).toEqual({
        statusCode: 401,
        error: 'UNAUTHORIZED',
      });
      expect(query).toHaveBeenCalledTimes(1);
    },
  );
});
