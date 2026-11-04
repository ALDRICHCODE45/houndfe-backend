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

  const confirmGrants = [
    poRead,
    { action: 'create', subject: 'ProcurementOrderConfirmation' },
  ];
  const cancelGrants = [
    poRead,
    { action: 'create', subject: 'ProcurementOrderCancellation' },
  ];
  function authorityTx(grants: Array<{ action: string; subject: string }>) {
    const query = jest.fn(async (sql: Prisma.Sql) =>
      sql.sql.includes('FROM "users"')
        ? [{ id: scope.actorId, isActive: true, name: 'Ana Compradora' }]
        : grants,
    );
    // SAFETY: authority uses only this query interface on its caller's transaction.
    return {
      query,
      tx: { $queryRaw: query } as unknown as Prisma.TransactionClient,
    };
  }

  it.each([
    ['CONFIRM', confirmGrants],
    ['CANCEL', cancelGrants],
  ] as const)(
    '%s needs only its own create grant plus PO read, no edit or catalog grants',
    async (operation, grants) => {
      const { tx, query } = authorityTx(grants);
      await expect(
        requirePurchaseOrderAuthority(tx, scope, operation),
      ).resolves.toEqual({ displayName: 'Ana Compradora' });
      expect(query.mock.calls[0][0].sql).toContain('u."name"');
    },
  );

  it.each([
    ['CONFIRM', confirmGrants],
    ['CANCEL', cancelGrants],
  ] as const)(
    '%s rejects each missing required grant',
    async (operation, grants) => {
      for (const missing of grants) {
        const { tx } = authorityTx(grants.filter((grant) => grant !== missing));
        await expect(
          requirePurchaseOrderAuthority(tx, scope, operation),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
    },
  );

  it('does not accept the other transition grant, nor PO update/delete, as authority', async () => {
    for (const [operation, grants] of [
      ['CONFIRM', cancelGrants],
      ['CANCEL', confirmGrants],
      [
        'CONFIRM',
        [
          poRead,
          { action: 'update', subject: 'ProcurementPurchaseOrder' },
          { action: 'delete', subject: 'ProcurementPurchaseOrder' },
        ],
      ],
    ] as const) {
      const { tx } = authorityTx([...grants]);
      await expect(
        requirePurchaseOrderAuthority(tx, scope, operation),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });
});
