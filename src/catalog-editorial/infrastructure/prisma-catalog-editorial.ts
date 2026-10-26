import { Prisma, PrismaClient } from '@prisma/client';
import { closedObject, validateDocument } from '../domain/document';
import type {
  CatalogEditorialCore,
  EditorialContext,
  EditorialCreateAuthority,
  EditorialCreateRequest,
  EditorialReadAuthority,
  EditorialReadResult,
} from '../application/catalog-editorial-core';

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

export class PrismaCatalogEditorial implements CatalogEditorialCore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly authority: EditorialReadAuthority,
    private readonly createAuthority?: EditorialCreateAuthority,
  ) {}
  async create(
    context: EditorialContext,
    request: EditorialCreateRequest,
  ): Promise<EditorialReadResult> {
    const scope = { ...context };
    closedObject(request, ['expectedCycle', 'idempotencyKey', 'document']);
    const input = { ...request, document: snapshot(request.document) };
    const work = async (tx: Prisma.TransactionClient) => {
      const access = await this.createAuthority
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
      const document = validateDocument(
        input.document,
        access.documentAuthority,
      );
      // Lock the existing Product, including when editorial state is still absent.
      const products = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT "id" FROM "products" WHERE "tenantId" = ${scope.tenantId}
          AND "id" = ${scope.productId} FOR UPDATE
      `);
      if (products.length !== 1) throw new Error('NOT_FOUND');
      const requestJson = JSON.stringify({
        expectedCycle: input.expectedCycle,
        document,
      });
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
      const result: EditorialReadResult = {
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
