import { Prisma } from '@prisma/client';
import type {
  EditorialContext,
  EditorialCreateAuthority,
  EditorialSaveAuthority,
} from '../application/catalog-editorial-core';
import {
  PrismaEditorialAuthority,
  type EditorialDocumentAuthorityProvider,
} from './prisma-editorial-authority';

import type { DocumentAuthority } from '../domain/document';

export type EditorialPreparationMode = 'create' | 'create-replay' | 'stored';
/** Bound to the factory's transaction; invoked only at core validation sites. */
export type EditorialDocumentPreparation = (
  context: Readonly<{
    scope: Readonly<EditorialContext>;
    documents: readonly unknown[];
    authority: Readonly<DocumentAuthority>;
    mode: EditorialPreparationMode;
  }>,
) => DocumentAuthority | null | Promise<DocumentAuthority | null>;

interface EditorialWriteAuthorities {
  createAuthority: EditorialCreateAuthority;
  saveAuthority: EditorialSaveAuthority;
  prepareDocuments?: EditorialDocumentPreparation;
}
export type EditorialWriteAuthorityFactory = (
  tx: Prisma.TransactionClient,
) =>
  | EditorialWriteAuthorities
  | null
  | Promise<EditorialWriteAuthorities | null>;

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
