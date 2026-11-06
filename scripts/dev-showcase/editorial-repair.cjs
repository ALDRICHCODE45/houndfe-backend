// Dev showcase › editorial repair (S5). Four Sucursal Centro products carry
// editorial documents saved before editorial V2; the editor cannot open them
// (409 EDITORIAL_STATE_UNREADABLE). They came from the old, unmerged
// chore/dev-catalog-seed branch and exist only in the dev database.
//
// Dry run by default (counts only). `--apply` clears just the slots that do not
// decode as V2, with the API's own decoder from dist/ (run `pnpm build` first).
// A cleared Published records unpublishedRevision, so revisions never repeat. A
// row is deleted only when no valid slot remains and no receipt references it;
// receipts are never deleted. Idempotent: a second run finds nothing to do.
// Prints counts and product names only, never document contents.
//
// Run: node scripts/dev-showcase/editorial-repair.cjs [--apply]
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Prisma, PrismaClient } = require('@prisma/client');

const ROOT = path.resolve(__dirname, '../..');
const TENANT_SLUG = 'centro';
const LEGACY_EDITORIAL_PRODUCTS = [
  'Collar ajustable Ruffwear Front Range',
  'Correa de nylon reforzada Kong 1.8 m',
  'Correa retráctil Flexi New Classic',
  'Croqueta Diamond Naturals Cordero y Arroz 13.6 kg',
];
const RECEIPT_TABLES = [
  'catalog_editorial_create_receipts',
  'catalog_editorial_save_receipts',
  'catalog_editorial_publish_receipts',
  'catalog_editorial_discard_receipts',
  'catalog_editorial_unpublish_receipts',
];
// The decoder only checks R's format; the repair never compares vocabularies.
const PROBE_REVISION = 'ev2-sha256-' + '0'.repeat(64);

function loadDecoder() {
  const file = path.join(
    ROOT,
    'dist/catalog-editorial/application/editorial-recorded-state-v2.js',
  );
  if (!fs.existsSync(file)) {
    throw new Error('dist/ missing the editorial decoder: run `pnpm build`');
  }
  return require(file).decodeRecordedEditorialStateV2;
}

/** True when the slot (or its absence) decodes as V2; only TypeError means no. */
function readable(decode, slot, key) {
  if (slot === null) return true;
  try {
    decode({
      contractVersion: 2,
      vocabularyRevision: PROBE_REVISION,
      state: {
        cycle: null,
        draft: key === 'draft' ? slot : null,
        published: key === 'published' ? slot : null,
      },
    });
    return true;
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

/**
 * Pure plan over rows `{ productId, name, draft, published, referenced }`.
 * Each row becomes `none`, `clear` (some slot stays or receipts reference it)
 * or `delete`; counts summarize the plan.
 */
function planRepair(rows, decode) {
  const counts = {
    rowsMatched: rows.length,
    slotsCleared: 0,
    rowsDeleted: 0,
    rowsKeptReferenced: 0,
  };
  const actions = rows.map((row) => {
    const clearDraft = !readable(decode, row.draft, 'draft');
    const clearPublished = !readable(decode, row.published, 'published');
    const base = { productId: row.productId, name: row.name };
    if (!clearDraft && !clearPublished) return { ...base, action: 'none' };
    counts.slotsCleared += Number(clearDraft) + Number(clearPublished);
    const empty =
      (row.draft === null || clearDraft) &&
      (row.published === null || clearPublished);
    if (empty && !row.referenced) {
      counts.rowsDeleted += 1;
      return { ...base, action: 'delete' };
    }
    if (empty) counts.rowsKeptReferenced += 1;
    return { ...base, action: 'clear', clearDraft, clearPublished };
  });
  return { counts, actions };
}

function statements(tenantId, action) {
  const where = Prisma.sql`WHERE "tenantId" = ${tenantId} AND "productId" = ${action.productId}`;
  if (action.action === 'delete')
    return [Prisma.sql`DELETE FROM "catalog_editorial_states" ${where}`];
  const sql = [];
  if (action.clearDraft)
    sql.push(Prisma.sql`UPDATE "catalog_editorial_states" SET
      "draftRevision" = NULL, "draftDocument" = NULL, "basePublishedRevision" = NULL
      ${where}`);
  if (action.clearPublished)
    sql.push(Prisma.sql`UPDATE "catalog_editorial_states" SET
      "unpublishedRevision" = GREATEST(COALESCE("unpublishedRevision", 0), "publishedRevision"),
      "publishedRevision" = NULL, "publishedDocument" = NULL, "publishedSubjects" = NULL
      ${where}`);
  return sql;
}

/** One transaction; rows are locked so the plan and the writes agree. */
async function repairLegacyEditorialStates(
  prisma,
  { apply = false, decode = loadDecoder() } = {},
) {
  return prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.findUnique({
      where: { slug: TENANT_SLUG },
      select: { id: true },
    });
    if (!tenant) throw new Error('Tenant centro missing: run `pnpm seed`');
    const referenced = Prisma.join(
      RECEIPT_TABLES.map(
        (
          table,
        ) => Prisma.sql`EXISTS (SELECT 1 FROM ${Prisma.raw(`"${table}"`)} r
          WHERE r."tenantId" = s."tenantId" AND r."productId" = s."productId")`,
      ),
      ' OR ',
    );
    const rows = await tx.$queryRaw(Prisma.sql`
      SELECT s."productId", p."name",
        CASE WHEN s."draftRevision" IS NULL THEN NULL ELSE jsonb_build_object(
          'revision', s."draftRevision", 'basePublishedRevision', s."basePublishedRevision",
          'document', s."draftDocument") END AS "draft",
        CASE WHEN s."publishedRevision" IS NULL THEN NULL ELSE jsonb_build_object(
          'revision', s."publishedRevision", 'document', s."publishedDocument") END AS "published",
        (${referenced}) AS "referenced"
      FROM "catalog_editorial_states" s
      JOIN "products" p ON p."tenantId" = s."tenantId" AND p."id" = s."productId"
      WHERE s."tenantId" = ${tenant.id}
        AND p."name" IN (${Prisma.join(LEGACY_EDITORIAL_PRODUCTS)})
      ORDER BY p."name"
      FOR UPDATE OF s
    `);
    const plan = planRepair(rows, decode);
    if (apply) {
      for (const action of plan.actions) {
        for (const sql of statements(tenant.id, action)) {
          if ((await tx.$executeRaw(sql)) !== 1)
            throw new Error(
              `editorial repair: ${action.name} changed meanwhile`,
            );
        }
      }
    }
    return {
      applied: apply,
      ...plan.counts,
      products: plan.actions
        .filter((action) => action.action !== 'none')
        .map((action) => action.name),
    };
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--apply'))
    throw new Error('Usage: editorial-repair.cjs [--apply]');
  const { loadEnv, assertSafeTarget } = require('./seed.cjs');
  loadEnv();
  assertSafeTarget();
  const prisma = new PrismaClient();
  try {
    const report = await repairLegacyEditorialStates(prisma, {
      apply: args.includes('--apply'),
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.applied && report.slotsCleared > 0)
      console.log('Dry run: nothing changed. Re-run with --apply.');
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : 'editorial repair failed',
    );
    process.exitCode = 1;
  });
}

module.exports = {
  LEGACY_EDITORIAL_PRODUCTS,
  TENANT_SLUG,
  planRepair,
  repairLegacyEditorialStates,
};
