import { Prisma, type PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  disconnectIntegrationPrisma,
  integrationPrisma,
} from '../../../test/integration/reset-db';
import { coversPublishedSubjectV2 } from '../domain/editorial-published-subjects-v2';
import { readEditorialPublishedCoverageV2 } from './prisma-editorial-published-coverage-v2';

// Real PostgreSQL: the stored recording, its CHECK and the migration default.
const tenantId = randomUUID();
const otherTenantId = randomUUID();
const document = { schemaVersion: 2 };
let prisma: PrismaClient;

async function product(
  owner: string,
  { variants = 0 }: { variants?: number } = {},
): Promise<{ productId: string; variantIds: string[] }> {
  const productId = randomUUID();
  await prisma.product.create({
    data: {
      id: productId,
      tenantId: owner,
      name: 'Producto ' + productId.slice(0, 8),
      hasVariants: variants > 0,
    },
  });
  const variantIds: string[] = [];
  for (let i = 0; i < variants; i++) {
    const id = randomUUID();
    await prisma.variant.create({
      data: { id, tenantId: owner, productId, name: `V${i}` },
    });
    variantIds.push(id);
  }
  return { productId, variantIds: variantIds.sort() };
}

async function state(
  owner: string,
  productId: string,
  published: { revision: number; subjects: unknown } | null,
) {
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "catalog_editorial_states"
      ("tenantId", "productId", "cycle", "publishedRevision", "publishedDocument",
       "publishedSubjects")
    VALUES (${owner}, ${productId}, 1, ${published?.revision ?? null},
      CAST(${published ? JSON.stringify(document) : null} AS JSONB),
      CAST(${published?.subjects === undefined || published.subjects === null ? null : JSON.stringify(published.subjects)} AS JSONB))`);
}

beforeAll(async () => {
  prisma = integrationPrisma();
  for (const id of [tenantId, otherTenantId])
    await prisma.tenant.create({
      data: { id, name: 'Coverage', slug: 'coverage-' + id },
    });
});

afterAll(async () => {
  try {
    await prisma.$executeRaw(Prisma.sql`
      DELETE FROM "catalog_editorial_states"
      WHERE "tenantId" IN (${tenantId}, ${otherTenantId})`);
    await prisma.tenant.deleteMany({
      where: { id: { in: [tenantId, otherTenantId] } },
    });
  } finally {
    await disconnectIntegrationPrisma();
  }
});

describe('published subject coverage on PostgreSQL', () => {
  it('reads the recorded subjects of current Published revisions only', async () => {
    const variants = await product(tenantId, { variants: 2 });
    const simple = await product(tenantId);
    const legacy = await product(tenantId);
    const draftOnly = await product(tenantId);
    const absent = await product(tenantId);
    await state(tenantId, variants.productId, {
      revision: 3,
      subjects: [variants.variantIds[0]],
    });
    await state(tenantId, simple.productId, { revision: 1, subjects: [null] });
    await state(tenantId, legacy.productId, { revision: 2, subjects: null });
    await state(tenantId, draftOnly.productId, null);

    const coverage = await readEditorialPublishedCoverageV2(prisma, tenantId, [
      variants.productId,
      simple.productId,
      legacy.productId,
      draftOnly.productId,
      absent.productId,
    ]);
    expect([...coverage.keys()].sort()).toEqual(
      [variants.productId, simple.productId, legacy.productId].sort(),
    );
    expect(coverage.get(variants.productId)).toEqual({
      publishedRevision: 3,
      subjects: [variants.variantIds[0]],
    });
    const covers = (productId: string, subject: string | null) =>
      coversPublishedSubjectV2(coverage.get(productId), subject);
    expect(covers(variants.productId, variants.variantIds[0])).toBe(true);
    expect(covers(variants.productId, variants.variantIds[1])).toBe(false);
    expect(covers(simple.productId, null)).toBe(true);
    expect(covers(legacy.productId, randomUUID())).toBe(true);
    expect(covers(draftOnly.productId, null)).toBe(false);
    expect(covers(absent.productId, null)).toBe(false);
  });

  it('is tenant-scoped and empty for no products', async () => {
    const foreign = await product(otherTenantId);
    await state(otherTenantId, foreign.productId, {
      revision: 1,
      subjects: [null],
    });
    expect(
      (
        await readEditorialPublishedCoverageV2(prisma, tenantId, [
          foreign.productId,
        ])
      ).size,
    ).toBe(0);
    expect(
      (await readEditorialPublishedCoverageV2(prisma, tenantId, [])).size,
    ).toBe(0);
  });

  it('the CHECK refuses a recording without Published or that is not an array', async () => {
    const { productId } = await product(tenantId);
    await expect(
      prisma.$executeRaw(Prisma.sql`
        INSERT INTO "catalog_editorial_states"
          ("tenantId", "productId", "cycle", "publishedSubjects")
        VALUES (${tenantId}, ${productId}, 1, '[null]'::jsonb)`),
    ).rejects.toMatchObject({ meta: { code: '23514' } });
    await expect(
      state(tenantId, productId, { revision: 1, subjects: { v: 1 } }),
    ).rejects.toMatchObject({ meta: { code: '23514' } });
    expect(
      await prisma.$queryRaw(Prisma.sql`
        SELECT 1 FROM "catalog_editorial_states"
        WHERE "tenantId" = ${tenantId} AND "productId" = ${productId}`),
    ).toEqual([]);
  });

  it('the migration default covers every current subject of already-published products', async () => {
    const variants = await product(tenantId, { variants: 2 });
    const simple = await product(tenantId);
    const draftOnly = await product(tenantId);
    await state(tenantId, variants.productId, { revision: 1, subjects: null });
    await state(tenantId, simple.productId, { revision: 4, subjects: null });
    await state(tenantId, draftOnly.productId, null);
    const migration = readFileSync(
      join(
        __dirname,
        '../../../prisma/migrations/20261105020000_catalog_editorial_published_subjects/migration.sql',
      ),
      'utf8',
    );
    const backfill = /UPDATE "catalog_editorial_states"[\s\S]*?;/.exec(
      migration,
    )![0];
    const read = (tx: Prisma.TransactionClient) =>
      tx.$queryRaw<{ productId: string; publishedSubjects: unknown }[]>(
        Prisma.sql`SELECT "productId", "publishedSubjects"
          FROM "catalog_editorial_states" WHERE "tenantId" = ${tenantId}
            AND "productId" IN (${variants.productId}, ${simple.productId},
              ${draftOnly.productId})`,
      );
    let observed: Map<string, unknown> | undefined;
    // Run the shipped statement, observe, and roll back: other rows stay untouched.
    await prisma
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(backfill);
        observed = new Map(
          (await read(tx)).map((row) => [row.productId, row.publishedSubjects]),
        );
        throw new Error('ROLLBACK');
      })
      .catch((error: Error) => {
        if (error.message !== 'ROLLBACK') throw error;
      });
    expect(observed).toEqual(
      new Map<string, unknown>([
        [variants.productId, variants.variantIds],
        [simple.productId, [null]],
        [draftOnly.productId, null],
      ]),
    );
  });
});
