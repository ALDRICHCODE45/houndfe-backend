import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';

export interface EditorialVariantContext {
  variants: { id: string; name: string }[];
}
/** Authorized caller only; one statement observes product and real variants. */
export class PrismaEditorialContext {
  constructor(private readonly prisma: Pick<PrismaClient, '$queryRaw'>) {}

  async read(scope: { tenantId: string; productId: string }) {
    const { tenantId, productId } = scope;
    const rows = await this.prisma.$queryRaw<
      EditorialVariantContext[]
    >(Prisma.sql`
      SELECT COALESCE((SELECT jsonb_agg(
        jsonb_build_object('id', v.id, 'name', v.name) ORDER BY v.name, v.id
      ) FROM variants v
        WHERE v."tenantId" = p."tenantId" AND v."productId" = p.id
      ), '[]'::jsonb) AS variants
      FROM products p WHERE p."tenantId" = ${tenantId} AND p.id = ${productId}
    `);
    if (rows.length !== 1) throw new Error('NOT_FOUND');
    return rows[0];
  }
}
