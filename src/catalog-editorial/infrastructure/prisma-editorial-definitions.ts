import type { PrismaClient } from '@prisma/client';
import type { EditorialDefinitionsSnapshot } from '../domain/editorial-definitions';

/** Internal company-wide source, not a Product-scoped authorization boundary. */
export class PrismaEditorialDefinitions {
  constructor(private readonly prisma: Pick<PrismaClient, '$queryRaw'>) {}

  async read(): Promise<EditorialDefinitionsSnapshot> {
    // One statement observes a single database snapshot, including every child collection.
    const rows = await this.prisma.$queryRaw<
      { snapshot: EditorialDefinitionsSnapshot }[]
    >`SELECT jsonb_build_object(
      'families', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', f.id, 'code', f.code,
        'bindings', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'definitionId', b."definitionId", 'owner', b.owner
        ) ORDER BY b."definitionId") FROM editorial_bindings b
          WHERE b."familyId" = f.id), '[]'::jsonb)
      ) ORDER BY f.code) FROM editorial_families f), '[]'::jsonb),
      'definitions', COALESCE((SELECT jsonb_agg(
        jsonb_build_object('id', d.id, 'code', d.code, 'type', d.type) ||
        CASE WHEN d.type = 'number' THEN jsonb_build_object(
          'units', COALESCE((SELECT jsonb_agg(u."unitCode" ORDER BY u."unitCode" NULLS FIRST)
            FROM editorial_units u WHERE u."definitionId" = d.id), '[]'::jsonb)
        ) WHEN d.type IN ('single', 'multi') THEN jsonb_build_object(
          'options', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'code', o.code, 'archived', o."archivedAt" IS NOT NULL
          ) ORDER BY o.code) FROM editorial_options o
            WHERE o."definitionId" = d.id), '[]'::jsonb)
        ) ELSE '{}'::jsonb END
        ORDER BY d.code
      ) FROM editorial_definitions d), '[]'::jsonb)
    ) AS snapshot`;
    // A dependency failure rejects; it is never converted into an empty catalogue.
    return rows[0].snapshot;
  }
}
