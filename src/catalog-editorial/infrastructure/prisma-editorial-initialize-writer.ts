import { Prisma, type PrismaClient } from '@prisma/client';
import { isDeepStrictEqual } from 'node:util';
import type { EditorialContext } from '../application/catalog-editorial-core';
import type { EditorialInitializeWriter } from '../application/editorial-initialize-writer';
import {
  decodeRecordedReceiptResultV2,
  type ReceiptResultV2,
} from '../application/editorial-recorded-receipt-result-v2';
import type { ReceiptRequestV2 } from '../application/editorial-write-request-v2';
import type { DocumentShapeV2 } from '../domain/editorial-document-shape-v2';
import { eligibleConservationBaselineV2 } from '../domain/editorial-conservation-baseline-v2';
import { conserveArchivedOptionsV2 } from '../domain/editorial-archived-option-conservation-v2';
import { readEditorialVocabulary } from '../application/editorial-vocabulary-read';
import { PrismaEditorialAuthority } from './prisma-editorial-authority';
import { PrismaEditorialVocabularySnapshot } from './prisma-editorial-vocabulary-snapshot';
import { readLockedEditorialReferences } from './prisma-locked-editorial-references';

const emptyDocument = (): DocumentShapeV2 => ({
  schemaVersion: 2,
  commercialTitle: null,
  description: null,
  mediaRefs: [],
  familyCode: null,
  values: [],
  facts: [],
});

export class PrismaEditorialInitializeWriter implements EditorialInitializeWriter {
  constructor(private readonly prisma: Pick<PrismaClient, '$transaction'>) {}

  initialize(
    context: EditorialContext,
    key: string,
    request: ReceiptRequestV2,
  ) {
    const scope = { ...context };
    const intent = structuredClone(request);
    const { expectedCycle } = intent.body;
    const requestJson = JSON.stringify(intent);
    return this.prisma.$transaction(
      async (tx) => {
        const access = await new PrismaEditorialAuthority(tx).resolve(scope);
        if (
          access?.activeMember !== true ||
          access.canRead !== true ||
          access.canCreate !== true ||
          access.actorId !== scope.actorId ||
          access.tenantId !== scope.tenantId ||
          access.productId !== scope.productId
        )
          throw new Error('FORBIDDEN');
        const products = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT "id" FROM "products" WHERE "tenantId" = ${scope.tenantId}
          AND "id" = ${scope.productId} FOR UPDATE
      `);
        if (products.length !== 1) throw new Error('NOT_FOUND');
        const receipts = await tx.$queryRaw<
          { matches: boolean; result: unknown }[]
        >(Prisma.sql`
        SELECT ("request" = CAST(${requestJson} AS JSONB)) AS matches, "result"
        FROM "catalog_editorial_create_receipts"
        WHERE "tenantId" = ${scope.tenantId} AND "productId" = ${scope.productId}
          AND "actorId" = ${scope.actorId} AND "idempotencyKey" = ${key}
      `);
        let result: ReceiptResultV2 | undefined;
        let freshResult: unknown;
        const replay = receipts[0];
        if (replay) {
          if (replay.matches !== true) throw new Error('CONFLICT');
          result = decodeRecordedReceiptResultV2(
            'initialize',
            intent,
            replay.result,
          );
          const { cycle, draft, published } = result.body.state;
          if (
            cycle !== (expectedCycle ?? 0) + 1 ||
            draft?.revision !== 1 ||
            draft.basePublishedRevision !== (published?.revision ?? null) ||
            !isDeepStrictEqual(
              draft.document,
              published?.document ?? emptyDocument(),
            )
          )
            throw new Error('INTERNAL_ERROR');
        } else {
          const states = await tx.$queryRaw<
            {
              cycle: number;
              draftRevision: number | null;
              published: unknown;
            }[]
          >(Prisma.sql`
          SELECT "cycle", "draftRevision",
            CASE WHEN "publishedRevision" IS NULL THEN NULL ELSE jsonb_build_object(
              'revision', "publishedRevision", 'document', "publishedDocument") END AS "published"
          FROM "catalog_editorial_states"
          WHERE "tenantId" = ${scope.tenantId} AND "productId" = ${scope.productId}
          FOR UPDATE
        `);
          const state = states[0];
          if (
            (state?.cycle ?? null) !== expectedCycle ||
            state?.draftRevision != null
          )
            throw new Error('CONFLICT');
          const cycle = (state?.cycle ?? 0) + 1;
          if (cycle > 2147483647) throw new Error('CONFLICT');
          const published = state?.published ?? null;
          // The decoder validates stored slots; no wrapping or fresh qualification.
          const source = published as {
            revision: unknown;
            document: unknown;
          } | null;
          freshResult = {
            receiptVersion: 2,
            status: 201,
            body: {
              contractVersion: 2,
              vocabularyRevision: intent.vocabularyRevision,
              state: {
                cycle,
                draft: {
                  revision: 1,
                  basePublishedRevision: source?.revision ?? null,
                  document: source === null ? emptyDocument() : source.document,
                },
                published,
              },
            },
            headers: {
              'Editorial-Contract-Version': '2',
              'Editorial-Vocabulary-Revision': intent.vocabularyRevision,
            },
            careAttestation: null,
          };
        }
        // All metadata, including insertions: families-first matches the seed order.
        // Replay needs current reference/conservation gates, but never current-R equality.
        await tx.$executeRaw(Prisma.sql`
        LOCK TABLE "editorial_families", "editorial_definitions", "editorial_bindings",
          "editorial_options", "editorial_units", "editorial_groups",
          "editorial_group_members", "editorial_aliases", "editorial_vocabulary_metadata"
        IN SHARE MODE
      `);
        const vocabulary = await readEditorialVocabulary(
          new PrismaEditorialVocabularySnapshot(tx),
        );
        if (
          !replay &&
          vocabulary.vocabularyRevision !== intent.vocabularyRevision
        )
          throw new Error('VOCABULARY_CHANGED');
        result ??= decodeRecordedReceiptResultV2(
          'initialize',
          intent,
          freshResult,
        );
        const document = result.body.state.draft!.document;
        const references = await readLockedEditorialReferences(
          tx,
          scope,
          document.mediaRefs,
        );
        const baseline = eligibleConservationBaselineV2(
          document,
          references,
          vocabulary.vocabulary,
        );
        if (replay && !baseline) throw new Error('MALFORMED');
        const warnings = baseline
          ? conserveArchivedOptionsV2(
              document,
              baseline,
              references,
              vocabulary.vocabulary,
            )
          : [];
        if (replay) return result; // Preserve recorded warnings, including absence/order.
        if (warnings.length) result.body.state.warnings = warnings;
        const draft = result.body.state.draft!;
        const updated = await tx.$executeRaw(Prisma.sql`
        INSERT INTO "catalog_editorial_states"
          ("tenantId", "productId", "cycle", "draftRevision", "basePublishedRevision", "draftDocument")
        VALUES (${scope.tenantId}, ${scope.productId}, ${result.body.state.cycle}, 1,
          ${draft.basePublishedRevision}, CAST(${JSON.stringify(document)} AS JSONB))
        ON CONFLICT ("tenantId", "productId") DO UPDATE SET
          "cycle" = EXCLUDED."cycle", "draftRevision" = 1,
          "basePublishedRevision" = EXCLUDED."basePublishedRevision",
          "draftDocument" = EXCLUDED."draftDocument"
      `);
        if (updated !== 1) throw new Error('CONFLICT');
        const inserted = await tx.$executeRaw(Prisma.sql`
        INSERT INTO "catalog_editorial_create_receipts"
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
