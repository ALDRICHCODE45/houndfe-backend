import { Prisma, type PrismaClient } from '@prisma/client';
import type { EditorialContext } from '../application/catalog-editorial-core';
import { presentPublicationReadinessV2 } from '../application/editorial-publication-readiness-v2';
import type { EditorialReadinessReader } from '../application/editorial-readiness-reader';
import { readEditorialVocabulary } from '../application/editorial-vocabulary-read';
import { EditorialDocumentShapeError } from '../domain/editorial-document-shape-error';
import {
  parseDocumentShapeV2,
  type DocumentShapeV2,
} from '../domain/editorial-document-shape-v2';
import {
  evaluatePublicationReadinessV2,
  type PublicationProblemV2,
} from '../domain/editorial-publication-readiness-v2';
import { readEditorialOfferedSubjectsV2 } from './prisma-editorial-offered-subjects-v2';
import { PrismaEditorialVocabularySnapshot } from './prisma-editorial-vocabulary-snapshot';
import { readEditorialReferencesSnapshot } from './prisma-locked-editorial-references';

const productItem = (
  problem: PublicationProblemV2['problem'],
): PublicationProblemV2 => ({
  scope: 'product',
  definitionCode: null,
  variantId: null,
  problem,
  detail: null,
});

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
        const states = await tx.$queryRaw<
          {
            cycle: number;
            draftRevision: number | null;
            draftDocument: unknown;
            publishedDocument: unknown;
          }[]
        >(Prisma.sql`
        SELECT "cycle", "draftRevision", "draftDocument", "publishedDocument"
        FROM "catalog_editorial_states"
        WHERE "tenantId" = ${scope.tenantId} AND "productId" = ${scope.productId}
      `);
        const state = states[0];
        const meta = {
          cycle: state?.cycle ?? null,
          draftRevision: state?.draftRevision ?? null,
          vocabularyRevision,
          definitions: vocabulary.vocabulary.definitions,
        };
        // No saved Draft: a 200 with one product item, like the read's null draft.
        if (!state || state.draftRevision === null)
          return presentPublicationReadinessV2({
            ...meta,
            familyCode: null,
            problems: [productItem('NO_DRAFT')],
          });
        let document: DocumentShapeV2;
        try {
          document = parseDocumentShapeV2(state.draftDocument);
        } catch (error) {
          if (!(error instanceof EditorialDocumentShapeError)) throw error;
          return presentPublicationReadinessV2({
            ...meta,
            familyCode: null,
            problems: [productItem('DRAFT_INVALID')],
          });
        }
        const references = await readEditorialReferencesSnapshot(
          tx,
          scope,
          document.mediaRefs,
        );
        const offeredSubjects = await readEditorialOfferedSubjectsV2(tx, scope);
        const problems = evaluatePublicationReadinessV2({
          document,
          references,
          vocabulary: vocabulary.vocabulary,
          offeredSubjects,
          publishedDocument: state.publishedDocument,
        });
        return presentPublicationReadinessV2({
          ...meta,
          familyCode: document.familyCode,
          problems,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
