import { Prisma, type PrismaClient } from '@prisma/client';
import {
  publishedDocumentV2Sql,
  type PublishedReadOptionsV2,
} from './prisma-editorial-published-coverage-v2';
import {
  decodePublishedSubjectsV2,
  type PublishedCoverageV2,
} from '../domain/editorial-published-subjects-v2';
import type {
  PublicFacetSourceV2,
  PublicFacetVocabularyV2,
} from '../domain/editorial-public-facets-v2';

function invalid(): never {
  throw new TypeError('Expected published facet sources V2');
}

function choiceOf(input: unknown): PublicFacetSourceV2['choices'][number] {
  if (!input || typeof input !== 'object') invalid();
  const { code, variantId, payload } = input as Record<string, unknown>;
  if (
    typeof code !== 'string' ||
    (variantId !== null && typeof variantId !== 'string') ||
    !payload ||
    typeof payload !== 'object'
  )
    invalid();
  const { type, value } = payload as Record<string, unknown>;
  if (type === 'single' && typeof value === 'string')
    return { code, variantId, options: [value] };
  if (
    type === 'multi' &&
    Array.isArray(value) &&
    value.every((option) => typeof option === 'string')
  )
    return { code, variantId, options: value };
  invalid();
}

/**
 * Every current Published version of the tenant with its coverage (P4 S5)
 * and only its `known` single/multi values (P4 S4): code, variantId and
 * option codes. Text, numbers, evidence, facts and every other document
 * field stay in the database. A Published row that is not document shape V2
 * (`publishedDocumentV2Sql`) counts as not published: it is left out and
 * reported to `onInvalid`. Explicitly tenant-qualified; one snapshot.
 */
export async function readEditorialTenantPublishedFacetSourcesV2(
  db: Pick<PrismaClient, '$queryRaw'> | Prisma.TransactionClient,
  tenantId: string,
  options: PublishedReadOptionsV2 = {},
): Promise<
  Map<string, PublicFacetSourceV2 & { coverage: PublishedCoverageV2 }>
> {
  if (typeof tenantId !== 'string' || tenantId.trim().length === 0)
    throw new TypeError('Invalid editorial published facets scope');
  const rows = await db.$queryRaw<
    {
      productId: string;
      publishedRevision: number;
      publishedSubjects: unknown;
      familyCode: string | null;
      choices: unknown;
      v2: boolean;
    }[]
  >(Prisma.sql`
    SELECT s."productId", s."publishedRevision", s."publishedSubjects",
      s."publishedDocument"->>'familyCode' AS "familyCode",
      ${publishedDocumentV2Sql(Prisma.sql`s."publishedDocument"`)} AS "v2",
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'code', v->'code', 'variantId', v->'variantId', 'payload', v->'payload'))
        FROM jsonb_array_elements(CASE
          WHEN jsonb_typeof(s."publishedDocument"->'values') = 'array'
          THEN s."publishedDocument"->'values' ELSE '[]'::jsonb END) AS v
        WHERE v->>'state' = 'known'
          AND v->'payload'->>'type' IN ('single', 'multi')
      ), '[]'::jsonb) AS "choices"
    FROM "catalog_editorial_states" s
    WHERE s."tenantId" = ${tenantId}
      AND s."publishedRevision" IS NOT NULL
  `);
  const skipped = rows.filter((row) => !row.v2).map((row) => row.productId);
  if (skipped.length) options.onInvalid?.(skipped);
  return new Map(
    rows
      .filter((row) => row.v2)
      .map((row) => {
        if (!Array.isArray(row.choices)) invalid();
        return [
          row.productId,
          {
            coverage: {
              publishedRevision: row.publishedRevision,
              subjects: decodePublishedSubjectsV2(row.publishedSubjects),
            },
            familyCode: row.familyCode,
            choices: row.choices.map(choiceOf),
          },
        ];
      }),
  );
}

/**
 * FACET single/multi bindings of every family (P4 S4) with es-MX definition
 * and option labels. Number/range FACETs are not filterable and are not read.
 */
export async function readEditorialPublicFacetVocabularyV2(
  db: Pick<PrismaClient, 'editorialBinding'>,
): Promise<PublicFacetVocabularyV2> {
  const bindings = await db.editorialBinding.findMany({
    where: {
      exposure: 'FACET',
      definition: { type: { in: ['single', 'multi'] } },
    },
    select: {
      family: { select: { code: true } },
      definition: {
        select: {
          code: true,
          label: true,
          options: {
            select: { code: true, label: true },
            orderBy: { sortOrder: 'asc' },
          },
        },
      },
    },
  });
  const definitions = new Map<
    string,
    { label: string; options: ReadonlyMap<string, string> }
  >();
  const byFamily = new Map<string, Set<string>>();
  for (const { family, definition } of bindings) {
    definitions.set(definition.code, {
      label: definition.label,
      options: new Map(definition.options.map((o) => [o.code, o.label])),
    });
    const codes = byFamily.get(family.code) ?? new Set<string>();
    codes.add(definition.code);
    byFamily.set(family.code, codes);
  }
  return { definitions, byFamily };
}
