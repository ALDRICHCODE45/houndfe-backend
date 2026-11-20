/**
 * Queue position (1-based) of every WAITING backorder among the given rows,
 * counted inside its own product/variant queue ordered by `(scheduledAt, id)`.
 * One query for all the queues the rows belong to. Shared by the bot and the
 * staff reads.
 */
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { queuePositions } from '../domain/backorder-rules';
import type { BackorderStatusValue } from '../domain/backorder-status';

type TenantClient = ReturnType<TenantPrismaService['getClient']>;

export async function readWaitingPositions(
  tx: TenantClient,
  tenantId: string,
  rows: ReadonlyArray<{
    status: BackorderStatusValue;
    productId: string;
    variantId: string | null;
  }>,
): Promise<Map<string, number>> {
  const queues = new Map<
    string,
    { productId: string; variantId: string | null }
  >();
  for (const row of rows) {
    if (row.status !== 'WAITING') continue;
    queues.set(`${row.productId}\u0000${row.variantId ?? ''}`, {
      productId: row.productId,
      variantId: row.variantId,
    });
  }
  if (queues.size === 0) return new Map();
  const waiting = await tx.backorder.findMany({
    where: {
      tenantId,
      status: 'WAITING',
      OR: [...queues.values()],
    },
    select: { id: true, productId: true, variantId: true, scheduledAt: true },
    orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
  });
  return queuePositions(waiting);
}
