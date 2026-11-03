/* eslint-disable @typescript-eslint/require-await -- Async Prisma mock boundary. */
import { Prisma } from '@prisma/client';
import { requirePurchaseOrderAuthority } from './po-authority';
import { purchaseOrderErrorEnvelope } from './po-contract';

const scope = { tenantId: 'tenant', actorId: 'actor' };
const poRead = { action: 'read', subject: 'ProcurementPurchaseOrder' };

describe('purchase-order current persisted authority', () => {
  it('READ requires only PO read, locks actual grant edges and qualifies membership', async () => {
    const query = jest.fn(async (sql: Prisma.Sql) =>
      sql.sql.includes('FROM "users"')
        ? [{ id: scope.actorId, isActive: true }]
        : [poRead],
    );
    // SAFETY: authority uses only this query interface on its caller's transaction.
    const tx = { $queryRaw: query } as unknown as Prisma.TransactionClient;
    await requirePurchaseOrderAuthority(tx, scope, 'READ');
    const grants = query.mock.calls[1][0];
    expect(grants.values).toEqual([scope.tenantId, scope.actorId]);
    expect(grants.sql).toContain('FOR SHARE OF m, r, rp, p');
    expect(grants.sql).toContain('r."tenantId" IS NULL');
    expect(query.mock.calls[0][0].sql).toContain('FOR SHARE OF u');
  });

  it.each(['missing', 'inactive', 'wrongActor'])(
    'rejects persisted %s user before grants',
    async (kind) => {
      const query = jest.fn(async () =>
        kind === 'missing'
          ? []
          : [
              {
                id: kind === 'wrongActor' ? 'other' : scope.actorId,
                isActive: kind !== 'inactive',
              },
            ],
      );
      // SAFETY: fixture supplies only the query method used at this boundary.
      const tx = { $queryRaw: query } as unknown as Prisma.TransactionClient;
      const error: unknown = await requirePurchaseOrderAuthority(
        tx,
        scope,
        'READ',
      ).catch((failure: unknown) => failure);
      expect(purchaseOrderErrorEnvelope(error)).toEqual({
        statusCode: 401,
        error: 'UNAUTHORIZED',
      });
      expect(query).toHaveBeenCalledTimes(1);
    },
  );

  it('does not treat an empty membership/grant join as authority', async () => {
    const query = jest.fn(async (sql: Prisma.Sql) =>
      sql.sql.includes('FROM "users"')
        ? [{ id: scope.actorId, isActive: true }]
        : [],
    );
    // SAFETY: fixture supplies only the query method used at this boundary.
    const tx = { $queryRaw: query } as unknown as Prisma.TransactionClient;
    await expect(
      requirePurchaseOrderAuthority(tx, scope, 'READ'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
