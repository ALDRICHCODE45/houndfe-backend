import { Prisma, PrismaClient } from '@prisma/client';
import { isDeepStrictEqual } from 'node:util';
import type { DocumentAuthority, EditorialDocument } from '../domain/document';
import { validateContextualDocument } from '../domain/contextual-document';
import { readLockedEditorialDefinitions } from './prisma-locked-editorial-definitions';
import {
  closedObject,
  emptyDocument,
  validateDocument,
} from '../domain/document';
import type {
  CatalogEditorialCore,
  EditorialContext,
  EditorialCreateAuthority,
  EditorialCreateRequest,
  EditorialInitializeRequest,
  EditorialReadAuthority,
  EditorialReadResult,
  EditorialSaveAuthority,
  EditorialSaveRequest,
} from '../application/catalog-editorial-core';

import type { EditorialWriteAuthorityFactory } from './prisma-editorial-write-authority';

type InputSnapshot =
  | string
  | number
  | boolean
  | null
  | undefined
  | InputSnapshot[]
  | { [key: string]: InputSnapshot };
function snapshot(value: unknown): InputSnapshot {
  if (Array.isArray(value)) return Array.from(value, snapshot);
  if (value && typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype)
      throw new Error('MALFORMED');
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, snapshot(item)]),
    );
  }
  if (value == null || ['string', 'number', 'boolean'].includes(typeof value))
    return value as InputSnapshot;
  throw new Error('MALFORMED');
}

const positiveRevision = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value > 0 &&
  value <= 2147483647;

async function validateStoredSave(
  tx: Prisma.TransactionClient,
  stored: unknown,
  candidate: unknown,
  authority: DocumentAuthority,
) {
  const extra =
    stored && typeof stored === 'object' && Object.hasOwn(stored, 'warnings')
      ? ['warnings']
      : [];
  const raw = closedObject(stored, ['cycle', 'draft', 'published', ...extra]);
  const draft = closedObject(raw.draft, [
    'revision',
    'basePublishedRevision',
    'document',
  ]);
  const published =
    raw.published === null
      ? null
      : closedObject(raw.published, ['revision', 'document']);
  if (
    !positiveRevision(raw.cycle) ||
    !positiveRevision(draft.revision) ||
    (draft.basePublishedRevision !== null &&
      !positiveRevision(draft.basePublishedRevision)) ||
    (published && !positiveRevision(published.revision))
  )
    throw new Error('MALFORMED');
  const definitions = await readLockedEditorialDefinitions(tx, [
    candidate,
    draft.document,
    ...(published ? [published.document] : []),
  ]);
  // These baselines come only from the scoped stored state or exactly matched receipt.
  // The strict validator checks each document before inspecting conservation membership.
  const check = (document: unknown) =>
    validateContextualDocument(
      document,
      authority,
      definitions,
      document as EditorialDocument,
    ).document;
  const baseline = check(draft.document);
  const validated = validateContextualDocument(
    candidate,
    authority,
    definitions,
    baseline,
  );
  const state: EditorialReadResult = {
    cycle: raw.cycle,
    draft: {
      revision: draft.revision,
      basePublishedRevision: draft.basePublishedRevision,
      document: baseline,
    },
    published: published
      ? {
          revision: published.revision as number,
          document: check(published.document),
        }
      : null,
    ...(validated.warnings.length ? { warnings: validated.warnings } : {}),
  };
  return { state, document: validated.document };
}

export class PrismaCatalogEditorial implements CatalogEditorialCore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly authority: EditorialReadAuthority,
    private readonly createAuthority?: EditorialCreateAuthority,
    private readonly saveAuthority?: EditorialSaveAuthority,
    private readonly writeAuthorityFactory?: EditorialWriteAuthorityFactory,
  ) {}
  private async writeAuthority(tx: Prisma.TransactionClient) {
    if (this.writeAuthorityFactory) {
      try {
        return await this.writeAuthorityFactory(tx);
      } catch {
        return null;
      }
    }
    return {
      createAuthority: this.createAuthority,
      saveAuthority: this.saveAuthority,
    };
  }
  async save(
    context: EditorialContext,
    request: EditorialSaveRequest,
  ): Promise<EditorialReadResult> {
    const scope = { ...context };
    closedObject(request, [
      'expectedCycle',
      'expectedRevision',
      'idempotencyKey',
      'document',
    ]);
    const input = { ...request, document: snapshot(request.document) };
    const work = async (tx: Prisma.TransactionClient) => {
      const authority = await this.writeAuthority(tx);
      const access = await authority?.saveAuthority
        ?.resolve({ ...scope })
        .catch(() => null);
      if (
        access?.activeMember !== true ||
        access.canSave !== true ||
        access.actorId !== scope.actorId ||
        access.tenantId !== scope.tenantId ||
        access.productId !== scope.productId ||
        access.documentAuthority?.tenantId !== scope.tenantId ||
        access.documentAuthority.productId !== scope.productId
      )
        throw new Error('FORBIDDEN');
      if (
        typeof input.idempotencyKey !== 'string' ||
        input.idempotencyKey.length < 1 ||
        input.idempotencyKey.length > 200 ||
        [input.expectedCycle, input.expectedRevision].some(
          (v) => !Number.isInteger(v) || v < 1,
        )
      )
        throw new Error('MALFORMED');
      const products = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT "id" FROM "products" WHERE "tenantId" = ${scope.tenantId}
          AND "id" = ${scope.productId} FOR UPDATE
      `);
      if (products.length !== 1) throw new Error('NOT_FOUND');
      const requestJson = JSON.stringify({
        expectedCycle: input.expectedCycle,
        expectedRevision: input.expectedRevision,
        document: input.document,
      });
      const receipts = await tx.$queryRaw<
        { matches: boolean; result: EditorialReadResult }[]
      >(Prisma.sql`
        SELECT ("request" = CAST(${requestJson} AS JSONB)) AS matches, "result"
        FROM "catalog_editorial_save_receipts"
        WHERE "tenantId" = ${scope.tenantId} AND "productId" = ${scope.productId}
          AND "actorId" = ${scope.actorId} AND "idempotencyKey" = ${input.idempotencyKey}
      `);
      if (receipts[0]) {
        if (!receipts[0].matches) throw new Error('CONFLICT');
        const replay = await validateStoredSave(
          tx,
          receipts[0].result,
          input.document,
          access.documentAuthority,
        );
        if (
          replay.state.cycle !== input.expectedCycle ||
          replay.state.draft?.revision !== input.expectedRevision + 1 ||
          !isDeepStrictEqual(replay.state.draft.document, replay.document)
        )
          throw new Error('MALFORMED');
        return replay.state;
      }
      const states = await tx.$queryRaw<EditorialReadResult[]>(Prisma.sql`
        SELECT "cycle", CASE WHEN "draftRevision" IS NULL THEN NULL ELSE jsonb_build_object(
          'revision', "draftRevision", 'basePublishedRevision', "basePublishedRevision",
          'document', "draftDocument") END AS "draft",
          CASE WHEN "publishedRevision" IS NULL THEN NULL ELSE jsonb_build_object(
          'revision', "publishedRevision", 'document', "publishedDocument") END AS "published"
        FROM "catalog_editorial_states"
        WHERE "tenantId" = ${scope.tenantId} AND "productId" = ${scope.productId}
      `);
      const state = states[0];
      if (
        state?.cycle !== input.expectedCycle ||
        state.draft?.revision !== input.expectedRevision ||
        input.expectedRevision >= 2147483647
      )
        throw new Error('CONFLICT');
      const validated = await validateStoredSave(
        tx,
        state,
        input.document,
        access.documentAuthority,
      );
      const { document } = validated;
      const updated = await tx.$executeRaw(Prisma.sql`
        UPDATE "catalog_editorial_states" SET "draftRevision" = "draftRevision" + 1,
          "draftDocument" = CAST(${JSON.stringify(document)} AS JSONB)
        WHERE "tenantId" = ${scope.tenantId} AND "productId" = ${scope.productId}
          AND "cycle" = ${input.expectedCycle} AND "draftRevision" = ${input.expectedRevision}
      `);
      if (updated !== 1) throw new Error('CONFLICT');
      const result: EditorialReadResult = {
        ...validated.state,
        draft: {
          ...state.draft,
          revision: input.expectedRevision + 1,
          document,
        },
      };
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "catalog_editorial_save_receipts"
          ("tenantId", "productId", "actorId", "idempotencyKey", "request", "result")
        VALUES (${scope.tenantId}, ${scope.productId}, ${scope.actorId}, ${input.idempotencyKey},
          CAST(${requestJson} AS JSONB), CAST(${JSON.stringify(result)} AS JSONB))
      `);
      return result;
    };
    return await this.prisma.$transaction(work, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
  }
  private async requireActiveCreateOptions(
    tx: Prisma.TransactionClient,
    document: EditorialDocument,
  ) {
    const pairs = new Map<string, Prisma.Sql>();
    for (const value of document.values) {
      const codes =
        value.type === 'single'
          ? [value.value]
          : value.type === 'multi'
            ? value.value
            : [];
      for (const code of codes) {
        pairs.set(
          JSON.stringify([value.code, value.type, code]),
          Prisma.sql`(d."code" = ${value.code} AND d."type" = ${value.type} AND o."code" = ${code})`,
        );
      }
    }
    if (!pairs.size) return;
    const rows = await tx.$queryRaw<{ archivedAt: Date | null }[]>(Prisma.sql`
      SELECT o."archivedAt" FROM "editorial_definitions" d
      JOIN "editorial_options" o ON o."definitionId" = d."id"
      WHERE ${Prisma.join([...pairs.values()], ' OR ')}
      ORDER BY d."id", o."code" FOR SHARE OF d, o
    `);
    // Missing membership denies; absence is never treated as a lockable active option.
    if (
      rows.length !== pairs.size ||
      rows.some((row) => row.archivedAt !== null)
    )
      throw new Error('MALFORMED');
  }
  initialize(context: EditorialContext, request: EditorialInitializeRequest) {
    return this.createDraft(context, request, true);
  }
  create(context: EditorialContext, request: EditorialCreateRequest) {
    return this.createDraft(context, request, false);
  }
  private async createDraft(
    context: EditorialContext,
    request: EditorialCreateRequest | EditorialInitializeRequest,
    fromPublished: boolean,
  ): Promise<EditorialReadResult> {
    const scope = { ...context };
    closedObject(
      request,
      fromPublished
        ? ['expectedCycle', 'idempotencyKey']
        : ['expectedCycle', 'idempotencyKey', 'document'],
    );
    const input = {
      ...request,
      document: fromPublished
        ? undefined
        : snapshot((request as EditorialCreateRequest).document),
    };
    const work = async (tx: Prisma.TransactionClient) => {
      const authority = await this.writeAuthority(tx);
      const access = await authority?.createAuthority
        ?.resolve({ ...scope })
        .catch(() => null);
      if (
        access?.activeMember !== true ||
        access.canCreate !== true ||
        access.actorId !== scope.actorId ||
        access.tenantId !== scope.tenantId ||
        access.productId !== scope.productId ||
        access.documentAuthority?.tenantId !== scope.tenantId ||
        access.documentAuthority.productId !== scope.productId
      )
        throw new Error('FORBIDDEN');
      if (
        typeof input.idempotencyKey !== 'string' ||
        input.idempotencyKey.length < 1 ||
        input.idempotencyKey.length > 200 ||
        (input.expectedCycle !== null &&
          (!Number.isInteger(input.expectedCycle) || input.expectedCycle < 1))
      )
        throw new Error('MALFORMED');
      let document = fromPublished
        ? emptyDocument()
        : validateDocument(input.document, access.documentAuthority);
      const validateInitialization = async (result: EditorialReadResult) => {
        const candidate =
          result?.published === null
            ? emptyDocument()
            : result?.published?.document;
        const validated = await validateStoredSave(
          tx,
          result,
          candidate,
          access.documentAuthority,
        );
        const { state } = validated;
        if (
          state.cycle !== (input.expectedCycle ?? 0) + 1 ||
          state.draft?.revision !== 1 ||
          state.draft.basePublishedRevision !==
            (state.published?.revision ?? null) ||
          !isDeepStrictEqual(state.draft.document, validated.document)
        )
          throw new Error('MALFORMED');
        return state;
      };
      // Lock the existing Product, including when editorial state is still absent.
      const products = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT "id" FROM "products" WHERE "tenantId" = ${scope.tenantId}
          AND "id" = ${scope.productId} FOR UPDATE
      `);
      if (products.length !== 1) throw new Error('NOT_FOUND');
      if (!fromPublished) await this.requireActiveCreateOptions(tx, document);
      const requestJson = JSON.stringify(
        fromPublished
          ? { operation: 'initialize', expectedCycle: input.expectedCycle }
          : { expectedCycle: input.expectedCycle, document },
      );
      const receipts = await tx.$queryRaw<
        { matches: boolean; result: EditorialReadResult }[]
      >(Prisma.sql`
        SELECT ("request" = CAST(${requestJson} AS JSONB)) AS matches, "result"
        FROM "catalog_editorial_create_receipts"
        WHERE "tenantId" = ${scope.tenantId} AND "productId" = ${scope.productId}
          AND "actorId" = ${scope.actorId} AND "idempotencyKey" = ${input.idempotencyKey}
      `);
      if (receipts[0]) {
        if (!receipts[0].matches) throw new Error('CONFLICT');
        if (fromPublished) return validateInitialization(receipts[0].result);
        const replayDocument = validateDocument(
          receipts[0].result?.draft?.document,
          access.documentAuthority,
        );
        if (!isDeepStrictEqual(replayDocument, document))
          throw new Error('MALFORMED');
        return receipts[0].result;
      }
      const states = await tx.$queryRaw<
        {
          cycle: number;
          draftRevision: number | null;
          publishedRevision: number | null;
          publishedDocument: NonNullable<
            EditorialReadResult['published']
          >['document'];
        }[]
      >(Prisma.sql`
        SELECT "cycle", "draftRevision", "publishedRevision", "publishedDocument"
        FROM "catalog_editorial_states"
        WHERE "tenantId" = ${scope.tenantId} AND "productId" = ${scope.productId}
      `);
      const state = states[0];
      if (
        (state?.cycle ?? null) !== input.expectedCycle ||
        state?.draftRevision != null
      )
        throw new Error('CONFLICT');
      const cycle = (state?.cycle ?? 0) + 1;
      if (cycle > 2147483647) throw new Error('CONFLICT');
      if (fromPublished)
        document =
          state?.publishedRevision == null
            ? emptyDocument()
            : state.publishedDocument;
      let result: EditorialReadResult = {
        cycle,
        draft: {
          revision: 1,
          basePublishedRevision: state?.publishedRevision ?? null,
          document,
        },
        published:
          state?.publishedRevision == null
            ? null
            : {
                revision: state.publishedRevision,
                document: state.publishedDocument,
              },
      };
      if (fromPublished) {
        result = await validateInitialization(result);
        document = result.draft!.document;
      }
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "catalog_editorial_states"
          ("tenantId", "productId", "cycle", "draftRevision", "basePublishedRevision", "draftDocument")
        VALUES (${scope.tenantId}, ${scope.productId}, ${cycle}, 1,
          ${result.draft!.basePublishedRevision}, CAST(${JSON.stringify(document)} AS JSONB))
        ON CONFLICT ("tenantId", "productId") DO UPDATE SET
          "cycle" = EXCLUDED."cycle", "draftRevision" = 1,
          "basePublishedRevision" = EXCLUDED."basePublishedRevision",
          "draftDocument" = EXCLUDED."draftDocument"
      `);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "catalog_editorial_create_receipts"
          ("tenantId", "productId", "actorId", "idempotencyKey", "request", "result")
        VALUES (${scope.tenantId}, ${scope.productId}, ${scope.actorId}, ${input.idempotencyKey},
          CAST(${requestJson} AS JSONB), CAST(${JSON.stringify(result)} AS JSONB))
      `);
      return result;
    };
    return await this.prisma.$transaction(work, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
  }
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
