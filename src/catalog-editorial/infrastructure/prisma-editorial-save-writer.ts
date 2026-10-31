import { Prisma, type PrismaClient } from '@prisma/client';
import { isDeepStrictEqual } from 'node:util';
import type { EditorialContext } from '../application/catalog-editorial-core';
import type { EditorialSaveWriter } from '../application/editorial-save-writer';
import {
  decodeRecordedReceiptResultV2,
  type ReceiptResultV2,
} from '../application/editorial-recorded-receipt-result-v2';
import type { ReceiptRequestV2 } from '../application/editorial-write-request-v2';
import { readEditorialVocabulary } from '../application/editorial-vocabulary-read';
import {
  parseDocumentShapeV2,
  type DocumentShapeV2,
} from '../domain/editorial-document-shape-v2';
import { EditorialDocumentShapeError } from '../domain/editorial-document-shape-error';
import { eligibleConservationBaselineV2 } from '../domain/editorial-conservation-baseline-v2';
import { conserveArchivedOptionsV2 } from '../domain/editorial-archived-option-conservation-v2';
import { admitFreshDocumentV2 } from '../domain/editorial-fresh-document-admission-v2';
import { PrismaEditorialAuthority } from './prisma-editorial-authority';
import { PrismaEditorialVocabularySnapshot } from './prisma-editorial-vocabulary-snapshot';
import { readLockedEditorialReferences } from './prisma-locked-editorial-references';

export class PrismaEditorialSaveWriter implements EditorialSaveWriter {
  constructor(private readonly prisma: Pick<PrismaClient, '$transaction'>) {}

  save(context: EditorialContext, key: string, request: ReceiptRequestV2) {
    const scope = { ...context };
    // The admitted intent is JSON. Capture its bytes before any asynchronous observation.
    const requestJson = JSON.stringify(request);
    const intent = JSON.parse(requestJson) as ReceiptRequestV2;
    if (!('document' in intent.body))
      throw new TypeError('Expected a save intent');
    const { expectedCycle, expectedRevision, document } = intent.body;
    return this.prisma.$transaction(
      async (tx) => {
        const access = await new PrismaEditorialAuthority(tx).resolve(scope);
        if (
          access?.activeMember !== true ||
          access.canRead !== true ||
          access.canSave !== true ||
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
        FROM "catalog_editorial_save_receipts"
        WHERE "tenantId" = ${scope.tenantId} AND "productId" = ${scope.productId}
          AND "actorId" = ${scope.actorId} AND "idempotencyKey" = ${key}
      `);
        const replay = receipts[0];
        let result: ReceiptResultV2 | undefined;
        let freshResult: unknown;
        let storedDocument: unknown;
        if (replay) {
          if (replay.matches !== true) throw new Error('CONFLICT');
          result = decodeRecordedReceiptResultV2('save', intent, replay.result);
          const { cycle, draft } = result.body.state;
          if (
            cycle !== expectedCycle ||
            draft?.revision !== expectedRevision + 1 ||
            !isDeepStrictEqual(draft.document, document)
          )
            throw new Error('INTERNAL_ERROR');
        } else {
          const states = await tx.$queryRaw<
            {
              cycle: number;
              draftRevision: number | null;
              basePublishedRevision: unknown;
              draftDocument: unknown;
              published: unknown;
            }[]
          >(Prisma.sql`
          SELECT "cycle", "draftRevision", "basePublishedRevision", "draftDocument",
            CASE WHEN "publishedRevision" IS NULL THEN NULL ELSE jsonb_build_object(
              'revision', "publishedRevision", 'document', "publishedDocument") END AS "published"
          FROM "catalog_editorial_states"
          WHERE "tenantId" = ${scope.tenantId} AND "productId" = ${scope.productId} FOR UPDATE
        `);
          const state = states[0];
          if (
            state?.cycle !== expectedCycle ||
            state.draftRevision !== expectedRevision ||
            expectedRevision >= 2147483647
          )
            throw new Error('CONFLICT');
          storedDocument = state.draftDocument;
          freshResult = {
            receiptVersion: 2,
            status: 200,
            body: {
              contractVersion: 2,
              vocabularyRevision: intent.vocabularyRevision,
              state: {
                cycle: expectedCycle,
                draft: {
                  revision: expectedRevision + 1,
                  basePublishedRevision: state.basePublishedRevision,
                  document,
                },
                published: state.published,
              },
            },
            headers: {
              'Editorial-Contract-Version': '2',
              'Editorial-Vocabulary-Revision': intent.vocabularyRevision,
            },
            careAttestation: null,
          };
        }
        // Stabilize the entire R, including insertion gaps; families-first matches seed order.
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
        result ??= decodeRecordedReceiptResultV2('save', intent, freshResult);
        let baseline: DocumentShapeV2 | null = null;
        if (!replay) {
          try {
            baseline = parseDocumentShapeV2(storedDocument);
          } catch (error) {
            if (!(error instanceof EditorialDocumentShapeError)) throw error;
          }
        }
        const recorded = [
          result.body.state.draft!.document,
          ...(replay && result.body.state.published
            ? [result.body.state.published.document]
            : []),
        ];
        const references = await readLockedEditorialReferences(tx, scope, [
          ...recorded.flatMap((d) => d.mediaRefs),
          ...(baseline?.mediaRefs ?? []),
        ]);
        if (replay) {
          for (const source of recorded) {
            const eligible = eligibleConservationBaselineV2(
              source,
              references,
              vocabulary.vocabulary,
            );
            if (!eligible) throw new Error('MALFORMED');
            conserveArchivedOptionsV2(
              source,
              eligible,
              references,
              vocabulary.vocabulary,
            );
          }
          return result; // Do not recompute recorded warning presence/order or apply fresh admission.
        }
        admitFreshDocumentV2(
          document,
          references,
          vocabulary.vocabulary,
          'save',
        );
        const warnings = conserveArchivedOptionsV2(
          document,
          baseline,
          references,
          vocabulary.vocabulary,
        );
        if (warnings.length) result.body.state.warnings = warnings;
        const updated = await tx.$executeRaw(Prisma.sql`
        UPDATE "catalog_editorial_states" SET "draftRevision" = ${expectedRevision + 1},
          "draftDocument" = CAST(${JSON.stringify(document)} AS JSONB)
        WHERE "tenantId" = ${scope.tenantId} AND "productId" = ${scope.productId}
          AND "cycle" = ${expectedCycle} AND "draftRevision" = ${expectedRevision}
      `);
        if (updated !== 1) throw new Error('CONFLICT');
        const inserted = await tx.$executeRaw(Prisma.sql`
        INSERT INTO "catalog_editorial_save_receipts"
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
