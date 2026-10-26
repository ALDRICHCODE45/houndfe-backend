import { Prisma, PrismaClient } from '@prisma/client';
import type {
  CatalogEditorialCore,
  EditorialContext,
  EditorialReadAuthority,
  EditorialReadResult,
} from '../application/catalog-editorial-core';

export class PrismaCatalogEditorial implements CatalogEditorialCore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly authority: EditorialReadAuthority,
  ) {}
  read(context: EditorialContext): Promise<EditorialReadResult> {
    const scope = { ...context };
    return this.prisma.$transaction(
      async (tx) => {
        const access = await this.authority
          .resolve({ ...scope })
          .catch(() => null);
        if (
          access?.activeMember !== true ||
          access.canRead !== true ||
          access.actorId !== scope.actorId ||
          access.tenantId !== scope.tenantId ||
          access.productId !== scope.productId
        )
          throw new Error('FORBIDDEN');
        const products = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
          SELECT "id" FROM "products"
          WHERE "tenantId" = ${scope.tenantId} AND "id" = ${scope.productId}
        `);
        if (products.length !== 1) throw new Error('NOT_FOUND');
        const states = await tx.$queryRaw<EditorialReadResult[]>(Prisma.sql`
          SELECT "cycle",
            CASE WHEN "draftRevision" IS NULL THEN NULL ELSE jsonb_build_object(
              'revision', "draftRevision", 'basePublishedRevision', "basePublishedRevision",
              'document', "draftDocument") END AS "draft",
            CASE WHEN "publishedRevision" IS NULL THEN NULL ELSE jsonb_build_object(
              'revision', "publishedRevision", 'document', "publishedDocument") END AS "published"
          FROM "catalog_editorial_states"
          WHERE "tenantId" = ${scope.tenantId} AND "productId" = ${scope.productId}
        `);
        return states[0] ?? { cycle: null, draft: null, published: null };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
