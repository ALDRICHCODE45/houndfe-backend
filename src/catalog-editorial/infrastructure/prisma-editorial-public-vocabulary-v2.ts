import type { PrismaClient } from '@prisma/client';
import type {
  PublicVocabularyBindingV2,
  PublicVocabularyV2,
} from '../domain/editorial-public-projection-v2';

/**
 * The public part of the global vocabulary for the given families (P4 S3):
 * FACET and DETAIL bindings only — INTERNAL bindings are never read — with
 * definition, option and unit es-MX labels. Current labels, not a revision pin:
 * labels are presentation.
 */
export async function readEditorialPublicVocabularyV2(
  db: Pick<PrismaClient, 'editorialBinding'>,
  familyCodes: readonly string[],
): Promise<PublicVocabularyV2> {
  if (familyCodes.length === 0) return new Map();
  const bindings = await db.editorialBinding.findMany({
    where: {
      exposure: { in: ['FACET', 'DETAIL'] },
      family: { code: { in: [...familyCodes] } },
    },
    select: {
      exposure: true,
      sortOrder: true,
      family: { select: { code: true } },
      definition: {
        select: {
          code: true,
          label: true,
          type: true,
          options: { select: { code: true, label: true } },
          units: { select: { unitCode: true, label: true } },
        },
      },
    },
  });
  const vocabulary = new Map<string, Map<string, PublicVocabularyBindingV2>>();
  for (const binding of bindings) {
    const family =
      vocabulary.get(binding.family.code) ??
      new Map<string, PublicVocabularyBindingV2>();
    vocabulary.set(binding.family.code, family);
    const { definition } = binding;
    family.set(definition.code, {
      definitionCode: definition.code,
      label: definition.label,
      type: definition.type,
      exposure: binding.exposure === 'FACET' ? 'FACET' : 'DETAIL',
      sortOrder: binding.sortOrder,
      options: new Map(definition.options.map((o) => [o.code, o.label])),
      units: new Map(
        definition.units.flatMap((u) =>
          u.unitCode === null ? [] : [[u.unitCode, u.label] as const],
        ),
      ),
    });
  }
  return vocabulary;
}
