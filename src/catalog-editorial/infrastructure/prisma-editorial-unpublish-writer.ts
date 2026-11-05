import { Prisma, type PrismaClient } from '@prisma/client';
import type { EditorialContext } from '../application/catalog-editorial-core';
import { decodeRecordedReceiptResultV2 } from '../application/editorial-recorded-receipt-result-v2';
import type { EditorialUnpublishWriter } from '../application/editorial-unpublish-writer';
import type { ReceiptRequestV2 } from '../application/editorial-write-request-v2';
import { readEditorialVocabulary } from '../application/editorial-vocabulary-read';
import { lockCatalogLifecycle } from './prisma-catalog-lifecycle-gate';
import { PrismaEditorialAuthority } from './prisma-editorial-authority';
import { PrismaEditorialVocabularySnapshot } from './prisma-editorial-vocabulary-snapshot';

/**
 * V2 unpublish (P4 S6): removes the current Published version and its covered
 * subjects; the Draft, if any, and the cycle are kept. The CAS names the
 * Published revision (`expectedRevision`). Lock order is publish's: catalog
 * lifecycle SHARE → Tenant SHARE → Product UPDATE → receipt → state FOR UPDATE
 * → vocabulary SHARE.
 */
export class PrismaEditorialUnpublishWriter implements EditorialUnpublishWriter {
  constructor(private readonly prisma: Pick<PrismaClient, '$transaction'>) {}

  unpublish(context: EditorialContext, key: string, request: ReceiptRequestV2) {
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
        FROM "catalog_editorial_unpublish_receipts"
        WHERE "tenantId" = ${scope.tenantId} AND "productId" = ${scope.productId}
          AND "actorId" = ${scope.actorId} AND "idempotencyKey" = ${key}
      `);
        if (receipts[0]) {
          if (receipts[0].matches !== true) throw new Error('CONFLICT');
          return decodeRecordedReceiptResultV2(
            'unpublish',
            intent,
            receipts[0].result,
          );
        }
        // The kept Draft is returned as stored; the removed Published is not read.
        const states = await tx.$queryRaw<
          { cycle: number; publishedRevision: number | null; draft: unknown }[]
        >(Prisma.sql`
        SELECT "cycle", "publishedRevision",
          CASE WHEN "draftRevision" IS NULL THEN NULL ELSE jsonb_build_object(
            'revision', "draftRevision", 'basePublishedRevision', "basePublishedRevision",
            'document', "draftDocument") END AS "draft"
        FROM "catalog_editorial_states"
        WHERE "tenantId" = ${scope.tenantId} AND "productId" = ${scope.productId}
        FOR UPDATE
      `);
        const state = states[0];
        if (
          state?.cycle !== expectedCycle ||
          state.publishedRevision !== expectedRevision
        )
          throw new Error('CONFLICT');
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
        const result = decodeRecordedReceiptResultV2('unpublish', intent, {
          receiptVersion: 2,
          status: 200,
          body: {
            contractVersion: 2,
            vocabularyRevision: intent.vocabularyRevision,
            state: { cycle: state.cycle, draft: state.draft, published: null },
          },
          headers: {
            'Editorial-Contract-Version': '2',
            'Editorial-Vocabulary-Revision': intent.vocabularyRevision,
          },
          careAttestation: null,
        });
        const updated = await tx.$executeRaw(Prisma.sql`
        UPDATE "catalog_editorial_states" SET
          "publishedRevision" = NULL, "publishedDocument" = NULL,
          "publishedSubjects" = NULL, "unpublishedRevision" = ${expectedRevision}
        WHERE "tenantId" = ${scope.tenantId} AND "productId" = ${scope.productId}
          AND "cycle" = ${expectedCycle} AND "publishedRevision" = ${expectedRevision}
      `);
        if (updated !== 1) throw new Error('CONFLICT');
        const inserted = await tx.$executeRaw(Prisma.sql`
        INSERT INTO "catalog_editorial_unpublish_receipts"
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
