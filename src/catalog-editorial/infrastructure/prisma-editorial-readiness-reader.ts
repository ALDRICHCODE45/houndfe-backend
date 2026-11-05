import { Prisma, type PrismaClient } from '@prisma/client';
import type { EditorialContext } from '../application/catalog-editorial-core';
import type { EditorialReadinessReader } from '../application/editorial-readiness-reader';
import { readEditorialVocabulary } from '../application/editorial-vocabulary-read';
import {
  assessSavedDraftV2,
  type SavedDraftV2,
} from './prisma-editorial-draft-readiness-v2';
import { PrismaEditorialVocabularySnapshot } from './prisma-editorial-vocabulary-snapshot';

/**
 * Evaluates the SAVED Draft in one READ ONLY RepeatableRead transaction: every
 * observation (product, vocabulary, state, references, E) comes from the same
 * snapshot, so the answer matches one saved state. Takes no locks and writes
 * nothing; publish re-runs the same evaluation under its own locks.
 */
export class PrismaEditorialReadinessReader implements EditorialReadinessReader {
  constructor(private readonly prisma: Pick<PrismaClient, '$transaction'>) {}

  read(context: EditorialContext, vocabularyRevision: string) {
    const scope = { ...context };
    return this.prisma.$transaction(
      async (tx) => {
        // Must precede the first query of the transaction.
        await tx.$executeRaw(Prisma.sql`SET TRANSACTION READ ONLY`);
        const products = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT "id" FROM "products"
        WHERE "tenantId" = ${scope.tenantId} AND "id" = ${scope.productId}
      `);
        if (products.length !== 1) throw new Error('NOT_FOUND');
        const vocabulary = await readEditorialVocabulary(
          new PrismaEditorialVocabularySnapshot(tx),
        );
        if (vocabulary.vocabularyRevision !== vocabularyRevision)
          throw new Error('VOCABULARY_CHANGED');
        const states = await tx.$queryRaw<SavedDraftV2[]>(Prisma.sql`
        SELECT "cycle", "draftRevision", "draftDocument", "publishedDocument"
        FROM "catalog_editorial_states"
        WHERE "tenantId" = ${scope.tenantId} AND "productId" = ${scope.productId}
      `);
        const { readiness } = await assessSavedDraftV2(
          tx,
          scope,
          states[0],
          vocabulary,
          'snapshot',
        );
        return readiness;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
