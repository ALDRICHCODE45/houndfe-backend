import { Prisma, type PrismaClient } from '@prisma/client';
import { EditorialDocumentShapeError } from '../domain/editorial-document-shape-error';
import { parseDocumentShapeV2 } from '../domain/editorial-document-shape-v2';
import {
  decodePublishedSubjectsV2,
  type PublishedCoverageV2,
} from '../domain/editorial-published-subjects-v2';

/** Receives, once per read, the products whose Published row was skipped. */
export type PublishedReadOptionsV2 = {
  onInvalid?: (productIds: string[]) => void;
};

/**
 * SQL test that a Published document has the document shape V2 at the top
 * level and in every value element (public readers, P4 S2): exact document
 * keys, `schemaVersion` 2, arrays, and each value's key set by state. Legacy
 * pre-V2 rows fail it. Nested payload, evidence and facts shapes are checked
 * by `parseDocumentShapeV2` where the document is read whole. CASE guards
 * keep `jsonb_object_keys`/`jsonb_array_elements` off non-objects/arrays.
 */
export function publishedDocumentV2Sql(document: Prisma.Sql): Prisma.Sql {
  const keyCount = (json: Prisma.Sql) =>
    Prisma.sql`(SELECT count(*) FROM jsonb_object_keys(${json}))`;
  const type = (json: Prisma.Sql) =>
    Prisma.sql`COALESCE(jsonb_typeof(${json}), '')`;
  return Prisma.sql`(CASE
    WHEN ${type(document)} <> 'object' THEN false
    WHEN ${type(Prisma.sql`${document}->'values'`)} <> 'array'
      OR ${type(Prisma.sql`${document}->'facts'`)} <> 'array'
      OR ${type(Prisma.sql`${document}->'mediaRefs'`)} <> 'array' THEN false
    ELSE ${document}->'schemaVersion' = '2'::jsonb
      AND ${keyCount(document)} = 7
      AND ${type(Prisma.sql`${document}->'commercialTitle'`)} IN ('string', 'null')
      AND ${type(Prisma.sql`${document}->'description'`)} IN ('string', 'null')
      AND ${type(Prisma.sql`${document}->'familyCode'`)} IN ('string', 'null')
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(${document}->'mediaRefs') AS m
        WHERE jsonb_typeof(m) <> 'string')
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(${document}->'facts') AS f
        WHERE jsonb_typeof(f) <> 'object')
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(${document}->'values') AS v
        WHERE CASE
          WHEN jsonb_typeof(v) <> 'object' THEN true
          ELSE NOT COALESCE(
            ${type(Prisma.sql`v->'code'`)} = 'string'
            AND v->>'owner' IN ('product', 'sellable')
            AND ${type(Prisma.sql`v->'variantId'`)} IN ('string', 'null')
            AND CASE v->>'state'
              WHEN 'known' THEN ${keyCount(Prisma.sql`v`)} = 6
                AND ${type(Prisma.sql`v->'payload'`)} = 'object'
                AND ${type(Prisma.sql`v->'evidence'`)} IN ('object', 'null')
              WHEN 'unknown' THEN ${keyCount(Prisma.sql`v`)} = 5
                AND v->'evidence' = 'null'::jsonb
              WHEN 'not_applicable' THEN ${keyCount(Prisma.sql`v`)} = 5
                AND v->'evidence' = 'null'::jsonb
              ELSE false
            END, false)
        END)
  END)`;
}

/**
 * Current Published coverage per product, for public consumers (P4 S5). Only
 * products with a Published version that reads as document shape V2 appear;
 * any other Published row counts as not published and is reported to
 * `onInvalid`. Ask `coversPublishedSubjectV2(map.get(productId), variantId | null)`.
 * Explicitly tenant-qualified; takes no locks and reads one snapshot.
 */
export async function readEditorialPublishedCoverageV2(
  db: Pick<PrismaClient, '$queryRaw'> | Prisma.TransactionClient,
  tenantId: string,
  productIds: readonly string[],
  options: PublishedReadOptionsV2 = {},
): Promise<Map<string, PublishedCoverageV2>> {
  if (typeof tenantId !== 'string' || tenantId.trim().length === 0)
    throw new TypeError('Invalid editorial published coverage scope');
  if (productIds.length === 0) return new Map();
  // Few products: read the documents whole and apply the full V2 parse.
  const rows = await db.$queryRaw<
    {
      productId: string;
      publishedRevision: number;
      publishedSubjects: unknown;
      publishedDocument: unknown;
    }[]
  >(Prisma.sql`
    SELECT "productId", "publishedRevision", "publishedSubjects", "publishedDocument"
    FROM "catalog_editorial_states"
    WHERE "tenantId" = ${tenantId}
      AND "productId" = ANY(CAST(${[...productIds]} AS TEXT[]))
      AND "publishedRevision" IS NOT NULL
  `);
  const coverage = new Map<string, PublishedCoverageV2>();
  const invalid: string[] = [];
  for (const row of rows) {
    try {
      parseDocumentShapeV2(row.publishedDocument);
    } catch (error) {
      if (!(error instanceof EditorialDocumentShapeError)) throw error;
      invalid.push(row.productId);
      continue;
    }
    coverage.set(row.productId, {
      publishedRevision: row.publishedRevision,
      subjects: decodePublishedSubjectsV2(row.publishedSubjects),
    });
  }
  if (invalid.length) options.onInvalid?.(invalid);
  return coverage;
}

/**
 * Same as `readEditorialPublishedCoverageV2`, for every product of the tenant
 * with a Published version (public listings filter before pagination). The
 * documents stay in the database: validity is `publishedDocumentV2Sql`.
 */
export async function readEditorialTenantPublishedCoverageV2(
  db: Pick<PrismaClient, '$queryRaw'> | Prisma.TransactionClient,
  tenantId: string,
  options: PublishedReadOptionsV2 = {},
): Promise<Map<string, PublishedCoverageV2>> {
  if (typeof tenantId !== 'string' || tenantId.trim().length === 0)
    throw new TypeError('Invalid editorial published coverage scope');
  const rows = await db.$queryRaw<
    {
      productId: string;
      publishedRevision: number;
      publishedSubjects: unknown;
      v2: boolean;
    }[]
  >(Prisma.sql`
    SELECT "productId", "publishedRevision", "publishedSubjects",
      ${publishedDocumentV2Sql(Prisma.sql`"publishedDocument"`)} AS "v2"
    FROM "catalog_editorial_states"
    WHERE "tenantId" = ${tenantId}
      AND "publishedRevision" IS NOT NULL
  `);
  const invalid = rows.filter((row) => !row.v2).map((row) => row.productId);
  if (invalid.length) options.onInvalid?.(invalid);
  return new Map(
    rows
      .filter((row) => row.v2)
      .map((row) => [
        row.productId,
        {
          publishedRevision: row.publishedRevision,
          subjects: decodePublishedSubjectsV2(row.publishedSubjects),
        },
      ]),
  );
}
