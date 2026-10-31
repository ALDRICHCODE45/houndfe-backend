import { Prisma, type PrismaClient } from '@prisma/client';
import type { EditorialContext } from '../application/catalog-editorial-core';
import type { EditorialDocumentReader } from '../application/editorial-document-reader';
import { decodeRecordedEditorialStateV2 } from '../application/editorial-recorded-state-v2';
import { createEditorialStateV2 } from '../application/editorial-state-v2';
import { readEditorialVocabulary } from '../application/editorial-vocabulary-read';
import { PrismaEditorialVocabularySnapshot } from './prisma-editorial-vocabulary-snapshot';

export class PrismaEditorialDocumentReader implements EditorialDocumentReader {
  constructor(private readonly prisma: Pick<PrismaClient, '$transaction'>) {}

  read(context: EditorialContext, vocabularyRevision: string) {
    const scope = { ...context };
    return this.prisma.$transaction(
      async (tx) => {
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
        const states = await tx.$queryRaw<unknown[]>(Prisma.sql`
        SELECT "cycle",
          CASE WHEN "draftRevision" IS NULL THEN NULL ELSE jsonb_build_object(
            'revision', "draftRevision", 'basePublishedRevision', "basePublishedRevision",
            'document', "draftDocument") END AS "draft",
          CASE WHEN "publishedRevision" IS NULL THEN NULL ELSE jsonb_build_object(
            'revision', "publishedRevision", 'document', "publishedDocument") END AS "published"
        FROM "catalog_editorial_states"
        WHERE "tenantId" = ${scope.tenantId} AND "productId" = ${scope.productId}
      `);
        const decoded = decodeRecordedEditorialStateV2({
          contractVersion: 2,
          vocabularyRevision,
          state:
            states.length === 0
              ? { cycle: null, draft: null, published: null }
              : states[0],
        });
        return createEditorialStateV2(vocabularyRevision, decoded.state);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
