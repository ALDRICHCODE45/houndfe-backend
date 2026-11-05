import { Prisma, type PrismaClient } from '@prisma/client';
import type { EditorialContext } from '../application/catalog-editorial-core';
import { buildFreshCareAttestationV2 } from '../application/editorial-fresh-care-attestation-v2';
import {
  EditorialPublicationNotReadyError,
  type EditorialPublishWriter,
} from '../application/editorial-publish-writer';
import { decodeRecordedReceiptResultV2 } from '../application/editorial-recorded-receipt-result-v2';
import type { ReceiptRequestV2 } from '../application/editorial-write-request-v2';
import { readEditorialVocabulary } from '../application/editorial-vocabulary-read';
import { lockCatalogLifecycle } from './prisma-catalog-lifecycle-gate';
import { PrismaEditorialAuthority } from './prisma-editorial-authority';
import {
  assessSavedDraftV2,
  type SavedDraftV2,
} from './prisma-editorial-draft-readiness-v2';
import { PrismaEditorialVocabularySnapshot } from './prisma-editorial-vocabulary-snapshot';

/**
 * V2 publish: copies the locked, ready saved Draft to Published as stored.
 * Lock order: catalog lifecycle SHARE → Tenant SHARE → Product UPDATE → state
 * FOR UPDATE → vocabulary SHARE, the order the offered-subject reader requires.
 */
export class PrismaEditorialPublishWriter implements EditorialPublishWriter {
  constructor(private readonly prisma: Pick<PrismaClient, '$transaction'>) {}

  publish(context: EditorialContext, key: string, request: ReceiptRequestV2) {
    const scope = { ...context };
    const intent = structuredClone(request);
    const { expectedCycle, expectedRevision } = intent.body as {
      expectedCycle: number;
      expectedRevision: number;
    };
    const requestJson = JSON.stringify(intent);
    return this.prisma.$transaction(
      async (tx) => {
        const access = await new PrismaEditorialAuthority(tx).resolve(scope);
        if (
          access?.activeMember !== true ||
          access.canRead !== true ||
          access.canPublish !== true ||
          access.actorId !== scope.actorId ||
          access.tenantId !== scope.tenantId ||
          access.productId !== scope.productId
        )
          throw new Error('FORBIDDEN');
        await lockCatalogLifecycle(tx, 'shared');
        const tenants = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT "id" FROM "tenants" WHERE "id" = ${scope.tenantId} FOR SHARE
      `);
        if (tenants.length !== 1) throw new Error('NOT_FOUND');
        const products = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT "id" FROM "products" WHERE "tenantId" = ${scope.tenantId}
          AND "id" = ${scope.productId} FOR UPDATE
      `);
        if (products.length !== 1) throw new Error('NOT_FOUND');
        const receipts = await tx.$queryRaw<
          { matches: boolean; result: unknown }[]
        >(Prisma.sql`
        SELECT ("request" = CAST(${requestJson} AS JSONB)) AS matches, "result"
        FROM "catalog_editorial_publish_receipts"
        WHERE "tenantId" = ${scope.tenantId} AND "productId" = ${scope.productId}
          AND "actorId" = ${scope.actorId} AND "idempotencyKey" = ${key}
      `);
        if (receipts[0]) {
          if (receipts[0].matches !== true) throw new Error('CONFLICT');
          // Recorded acknowledgement, audit included: no re-evaluation or re-confirmation.
          return decodeRecordedReceiptResultV2(
            'publish',
            intent,
            receipts[0].result,
          );
        }
        const states = await tx.$queryRaw<
          (SavedDraftV2 & { publishedRevision: number | null })[]
        >(Prisma.sql`
        SELECT "cycle", "draftRevision", "draftDocument", "publishedRevision",
          "publishedDocument"
        FROM "catalog_editorial_states"
        WHERE "tenantId" = ${scope.tenantId} AND "productId" = ${scope.productId}
        FOR UPDATE
      `);
        const state = states[0];
        if (
          state?.cycle !== expectedCycle ||
          state.draftRevision !== expectedRevision ||
          (state.publishedRevision ?? 0) >= 2147483647
        )
          throw new Error('CONFLICT');
        const publishedRevision = (state.publishedRevision ?? 0) + 1;
        // Families first matches the seed's lock order; see the discard writer.
        await tx.$executeRaw(Prisma.sql`
        LOCK TABLE "editorial_families", "editorial_definitions", "editorial_bindings",
          "editorial_options", "editorial_units", "editorial_groups",
          "editorial_group_members", "editorial_aliases", "editorial_vocabulary_metadata"
        IN SHARE MODE
      `);
        // Separate statement: ReadCommitted must take a fresh snapshot AFTER locks.
        const vocabulary = await readEditorialVocabulary(
          new PrismaEditorialVocabularySnapshot(tx),
        );
        if (vocabulary.vocabularyRevision !== intent.vocabularyRevision)
          throw new Error('VOCABULARY_CHANGED');
        const { readiness, document, offeredSubjects } =
          await assessSavedDraftV2(tx, scope, state, vocabulary, 'locked');
        if (!readiness.ready || document === null)
          throw new EditorialPublicationNotReadyError({
            items: readiness.items,
            bySection: readiness.bySection,
          });
        // Ready care requires review-v1; any other family forbids it (400 MALFORMED).
        const careAttestation = buildFreshCareAttestationV2({
          scope,
          attempt: {
            cycle: expectedCycle,
            draftRevision: expectedRevision,
            publishedRevision,
            vocabularyRevision: intent.vocabularyRevision,
          },
          confirmedAt: new Date().toISOString(),
          document,
          evaluationSubjects: offeredSubjects,
          confirmation: intent.careConfirmation,
        });
        const result = decodeRecordedReceiptResultV2('publish', intent, {
          receiptVersion: 2,
          status: 200,
          body: {
            contractVersion: 2,
            vocabularyRevision: intent.vocabularyRevision,
            state: {
              cycle: state.cycle,
              draft: null,
              published: {
                revision: publishedRevision,
                document: state.draftDocument,
              },
            },
          },
          headers: {
            'Editorial-Contract-Version': '2',
            'Editorial-Vocabulary-Revision': intent.vocabularyRevision,
          },
          careAttestation,
        });
        // The stored Draft bytes become Published; only the latest Published is kept.
        const updated = await tx.$executeRaw(Prisma.sql`
        UPDATE "catalog_editorial_states" SET
          "publishedRevision" = ${publishedRevision}, "publishedDocument" = "draftDocument",
          "draftRevision" = NULL, "draftDocument" = NULL, "basePublishedRevision" = NULL
        WHERE "tenantId" = ${scope.tenantId} AND "productId" = ${scope.productId}
          AND "cycle" = ${expectedCycle} AND "draftRevision" = ${expectedRevision}
      `);
        if (updated !== 1) throw new Error('CONFLICT');
        const inserted = await tx.$executeRaw(Prisma.sql`
        INSERT INTO "catalog_editorial_publish_receipts"
          ("tenantId", "productId", "actorId", "idempotencyKey", "request", "result")
        VALUES (${scope.tenantId}, ${scope.productId}, ${scope.actorId}, ${key},
          CAST(${requestJson} AS JSONB), CAST(${JSON.stringify(result)} AS JSONB))
      `);
        if (inserted !== 1) throw new Error('INTERNAL_ERROR');
        return result;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }
}
