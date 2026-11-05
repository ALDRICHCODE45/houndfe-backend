import { Prisma, type PrismaClient } from '@prisma/client';
import {
  decodePublishedSubjectsV2,
  type PublishedCoverageV2,
} from '../domain/editorial-published-subjects-v2';

/**
 * Current Published coverage per product, for public consumers (P4 S5). Only
 * products with a Published version appear; ask
 * `coversPublishedSubjectV2(map.get(productId), variantId | null)`.
 * Explicitly tenant-qualified; takes no locks and reads one snapshot.
 */
export async function readEditorialPublishedCoverageV2(
  db: Pick<PrismaClient, '$queryRaw'> | Prisma.TransactionClient,
  tenantId: string,
  productIds: readonly string[],
): Promise<Map<string, PublishedCoverageV2>> {
  if (typeof tenantId !== 'string' || tenantId.trim().length === 0)
    throw new TypeError('Invalid editorial published coverage scope');
  if (productIds.length === 0) return new Map();
  return read(
    db,
    tenantId,
    Prisma.sql`AND "productId" = ANY(CAST(${[...productIds]} AS TEXT[]))`,
  );
}

/**
 * Same as `readEditorialPublishedCoverageV2`, for every product of the tenant
 * with a Published version (public listings filter before pagination).
 */
export async function readEditorialTenantPublishedCoverageV2(
  db: Pick<PrismaClient, '$queryRaw'> | Prisma.TransactionClient,
  tenantId: string,
): Promise<Map<string, PublishedCoverageV2>> {
  if (typeof tenantId !== 'string' || tenantId.trim().length === 0)
    throw new TypeError('Invalid editorial published coverage scope');
  return read(db, tenantId, Prisma.empty);
}

async function read(
  db: Pick<PrismaClient, '$queryRaw'> | Prisma.TransactionClient,
  tenantId: string,
  products: Prisma.Sql,
): Promise<Map<string, PublishedCoverageV2>> {
  const rows = await db.$queryRaw<
    {
      productId: string;
      publishedRevision: number;
      publishedSubjects: unknown;
    }[]
  >(Prisma.sql`
    SELECT "productId", "publishedRevision", "publishedSubjects"
    FROM "catalog_editorial_states"
    WHERE "tenantId" = ${tenantId}
      ${products}
      AND "publishedRevision" IS NOT NULL
  `);
  return new Map(
    rows.map((row) => [
      row.productId,
      {
        publishedRevision: row.publishedRevision,
        subjects: decodePublishedSubjectsV2(row.publishedSubjects),
      },
    ]),
  );
}
