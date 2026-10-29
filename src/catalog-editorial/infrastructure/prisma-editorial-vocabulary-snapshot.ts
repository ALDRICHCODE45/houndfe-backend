import type { PrismaClient } from '@prisma/client';

/** Dormant raw observation; not a validated transport snapshot. */
export class PrismaEditorialVocabularySnapshot {
  constructor(private readonly prisma: Pick<PrismaClient, '$queryRaw'>) {}

  async read(): Promise<unknown> {
    const rows: unknown = await this.prisma.$queryRaw`
      SELECT jsonb_build_object(
        'metadata', (SELECT to_jsonb(m) FROM editorial_vocabulary_metadata m WHERE m.id = 'global'),
        'families', COALESCE((SELECT jsonb_agg(to_jsonb(f) || jsonb_build_object(
          'bindings', COALESCE((SELECT jsonb_agg(to_jsonb(b) || jsonb_build_object(
            'definitionCode', d.code
          ) ORDER BY b."sortOrder", d.code)
            FROM editorial_bindings b JOIN editorial_definitions d ON d.id = b."definitionId"
            WHERE b."familyId" = f.id), '[]'::jsonb)
        ) ORDER BY f.label, f.code) FROM editorial_families f), '[]'::jsonb),
        'definitions', COALESCE((SELECT jsonb_agg(to_jsonb(d) || jsonb_build_object(
          'units', COALESCE((SELECT jsonb_agg(to_jsonb(u)
            ORDER BY u."sortOrder", u."unitCode" NULLS FIRST)
            FROM editorial_units u WHERE u."definitionId" = d.id), '[]'::jsonb),
          'options', COALESCE((SELECT jsonb_agg(to_jsonb(o) ORDER BY o."sortOrder", o.code)
            FROM editorial_options o WHERE o."definitionId" = d.id), '[]'::jsonb),
          'groups', COALESCE((SELECT jsonb_agg(to_jsonb(g) || jsonb_build_object(
            'members', COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m."optionCode")
              FROM editorial_group_members m
              WHERE m."definitionId" = g."definitionId" AND m."groupCode" = g.code), '[]'::jsonb)
          ) ORDER BY g.code) FROM editorial_groups g WHERE g."definitionId" = d.id), '[]'::jsonb),
          'aliases', COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.label, a."optionCode")
            FROM editorial_aliases a WHERE a."definitionId" = d.id), '[]'::jsonb)
        ) ORDER BY d.code) FROM editorial_definitions d), '[]'::jsonb)
      ) AS snapshot`;
    if (!Array.isArray(rows) || rows.length !== 1) {
      throw new Error('Invalid vocabulary snapshot result');
    }
    const row: unknown = rows[0];
    const snapshot: unknown =
      row && typeof row === 'object' && 'snapshot' in row
        ? row.snapshot
        : undefined;
    if (
      !snapshot ||
      typeof snapshot !== 'object' ||
      Array.isArray(snapshot) ||
      !('metadata' in snapshot) ||
      !('families' in snapshot) ||
      !Array.isArray(snapshot.families) ||
      !('definitions' in snapshot) ||
      !Array.isArray(snapshot.definitions) ||
      (snapshot.metadata !== null &&
        (typeof snapshot.metadata !== 'object' ||
          Array.isArray(snapshot.metadata)))
    ) {
      throw new Error('Invalid vocabulary snapshot result');
    }
    return snapshot;
  }
}
