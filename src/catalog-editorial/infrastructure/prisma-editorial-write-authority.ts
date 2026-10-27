import { Prisma } from '@prisma/client';
import type {
  EditorialCreateAuthority,
  EditorialSaveAuthority,
} from '../application/catalog-editorial-core';
import {
  PrismaEditorialAuthority,
  type EditorialDocumentAuthorityProvider,
} from './prisma-editorial-authority';

export type EditorialWriteAuthorityFactory = (tx: Prisma.TransactionClient) =>
  | {
      createAuthority: EditorialCreateAuthority;
      saveAuthority: EditorialSaveAuthority;
    }
  | null
  | Promise<{
      createAuthority: EditorialCreateAuthority;
      saveAuthority: EditorialSaveAuthority;
    } | null>;

/** Internal opt-in composition; no reference reader or runtime registration. */
export function createPrismaEditorialWriteAuthority(
  tx: Prisma.TransactionClient,
  documents: (
    tx: Prisma.TransactionClient,
  ) => EditorialDocumentAuthorityProvider,
): PrismaEditorialAuthority {
  return new PrismaEditorialAuthority(tx, {
    resolve: async (scope) => {
      // PrismaEditorialAuthority checks exact capabilities before invoking this port.
      const products = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT "id" FROM "products" WHERE "tenantId" = ${scope.tenantId}
          AND "id" = ${scope.productId} FOR UPDATE
      `);
      if (products.length !== 1 || products[0].id !== scope.productId)
        return null;
      return documents(tx).resolve({ ...scope });
    },
  });
}
