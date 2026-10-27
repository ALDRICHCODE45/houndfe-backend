import type { PrismaClient } from '@prisma/client';

/** Company-wide vocabulary, observed in one SQL statement; caller authorizes. */
export class PrismaEditorialVocabulary {
  constructor(private readonly prisma: Pick<PrismaClient, '$queryRaw'>) {}

  async read(): Promise<unknown> {
    const rows = await this.prisma.$queryRaw<{ snapshot: unknown }[]>`
      SELECT jsonb_build_object(
        'families', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id', f.id, 'code', f.code, 'label', f.label,
          'bindings', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'definitionId', d.id, 'definitionCode', d.code,
            'owner', b.owner, 'sortOrder', b."sortOrder"
          ) ORDER BY b."sortOrder", d.code)
            FROM editorial_bindings b JOIN editorial_definitions d ON d.id = b."definitionId"
            WHERE b."familyId" = f.id), '[]'::jsonb)
        ) ORDER BY f.label, f.code) FROM editorial_families f), '[]'::jsonb),
        'definitions', COALESCE((SELECT jsonb_agg(
          jsonb_build_object('id', d.id, 'code', d.code, 'label', d.label, 'type', d.type) ||
          CASE WHEN d.type = 'number' THEN jsonb_build_object(
            'units', COALESCE((SELECT jsonb_agg(jsonb_build_object(
              'code', u."unitCode", 'label', u.label, 'sortOrder', u."sortOrder"
            ) ORDER BY u."sortOrder", u."unitCode" NULLS FIRST)
              FROM editorial_units u WHERE u."definitionId" = d.id), '[]'::jsonb)
          ) WHEN d.type IN ('single', 'multi') THEN jsonb_build_object(
            'options', COALESCE((SELECT jsonb_agg(jsonb_build_object(
              'code', o.code, 'label', o.label, 'archived', o."archivedAt" IS NOT NULL,
              'sortOrder', o."sortOrder"
            ) ORDER BY o."sortOrder", o.code)
              FROM editorial_options o WHERE o."definitionId" = d.id), '[]'::jsonb)
          ) ELSE '{}'::jsonb END ORDER BY d.code
        ) FROM editorial_definitions d), '[]'::jsonb)
      ) AS snapshot`;
    return rows[0].snapshot;
  }
}
