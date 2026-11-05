import { Prisma, type PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { buildProductionVocabularyManifest } from '../../../../prisma/editorial-production-vocabulary.manifest';
import { productionVocabularyRows } from '../../../../prisma/editorial-production-vocabulary-rows';

/**
 * Real-PostgreSQL support for publication specs: the canonical production
 * vocabulary and real V2 drafts per family. Vocabulary is global, so specs
 * install it into an empty test vocabulary and truncate it afterwards.
 */
export const evidence = {
  sourceRef: 'Etiqueta del empaque',
  verifiedOn: '2026-11-01',
};

type Value = Record<string, unknown>;
export const known = (
  code: string,
  payload: Value,
  withEvidence = true,
): Value => ({
  code,
  owner: 'sellable',
  variantId: null,
  state: 'known',
  payload,
  evidence: withEvidence ? evidence : null,
});
export const fact = (key: string, value: unknown) => ({
  key,
  state: 'known',
  value,
  evidence,
  basis: 'Dice el empaque',
});
const single = (code: string, value: string) =>
  known(code, { type: 'single', value });
const mass = (value: number) =>
  known('measure.net_mass', { type: 'number', value, unit: 'kg' });

function draft(
  familyCode: string,
  commercialTitle: string,
  values: Value[],
  declarations: unknown[],
  careReview: unknown = null,
) {
  return {
    schemaVersion: 2,
    commercialTitle,
    description: null,
    mediaRefs: [],
    familyCode,
    values,
    facts: [
      { variantId: null, presentation: 'Pieza', declarations, careReview },
    ],
  };
}

export const readyCareReview = () => ({
  state: 'prepared',
  jurisdiction: 'MX',
  intendedUse: 'Limpieza de oídos',
  determination: 'identified',
  basis: 'Revisión de la etiqueta',
  evidence: [evidence],
  requirements: [
    {
      key: 'r',
      description: 'Registro sanitario',
      disposition: 'satisfied',
      evidence: [evidence],
      basis: 'Número en el empaque',
    },
  ],
  warnings: [
    {
      key: 'w',
      requirementKeys: ['r'],
      text: 'No usar en heridas',
      disclosure: 'private_only',
      evidence: [evidence],
      handlingBasis: 'Se maneja en mostrador',
    },
  ],
});

/** One complete, publishable simple-product draft per production family. */
export const readyDrafts = {
  food: () =>
    draft(
      'food',
      'Croquetas para perro adulto 2 kg',
      [
        known('animal.target', { type: 'multi', value: ['ani.dom.dog'] }),
        single('food.format', 'food.format.kibble'),
        mass(2),
      ],
      [fact('contentMagnitude', 'mass')],
    ),
  treat: () =>
    draft(
      'treat',
      'Premios de pollo 100 g',
      [
        known('animal.target', { type: 'multi', value: ['ani.dom.dog'] }),
        single('treat.form', 'treat.form.stick'),
        mass(0.1),
      ],
      [fact('contentMagnitude', 'mass')],
    ),
  toy: () =>
    draft(
      'toy',
      'Pelota de hule',
      [
        known('animal.target', { type: 'multi', value: ['ani.dom.dog'] }),
        known('toy.type', { type: 'multi', value: ['toy.type.ball'] }),
      ],
      [
        fact('relevantDimensionCodes', {
          codes: [],
          toyTypes: ['toy.type.ball'],
        }),
      ],
    ),
  hygiene: () =>
    draft(
      'hygiene',
      'Cepillo para pelo',
      [single('hygiene.type', 'hygiene.type.brush')],
      [fact('consumable', false), fact('animalApplied', false)],
    ),
  accessory: () =>
    draft(
      'accessory',
      'Collar de nylon',
      [single('accessory.type', 'accessory.type.collar')],
      [
        fact('fitDeterminesChoice', false),
        fact('relevantFitCodes', []),
        fact('capacityDeterminesChoice', false),
        fact('relevantCapacityCodes', []),
        fact('electricalApplies', false),
        fact('relevantEquipmentCodes', []),
      ],
    ),
  care: (careReview: unknown = readyCareReview()) =>
    draft(
      'care',
      'Limpiador ótico 120 ml',
      [
        single('care.type', 'care.type.grooming'),
        single('care.form', 'care.form.solution'),
        known('measure.net_volume', { type: 'number', value: 120, unit: 'ml' }),
      ],
      [
        fact('contentMagnitude', 'volume'),
        fact('presentationKind', 'formulation'),
      ],
      careReview,
    ),
};

/**
 * The 68 canonical production rows, as the install helper writes them (that
 * helper cannot run under Jest: its structuredClone yields cross-realm objects
 * that canonical JSON rejects). No starter family is needed here.
 */
export async function installCanonicalVocabulary(
  prisma: PrismaClient,
): Promise<void> {
  const [{ count }] = await prisma.$queryRaw<{ count: number }[]>(
    Prisma.sql`SELECT count(*)::int AS count FROM "editorial_families"`,
  );
  // Vocabulary is global: never install over, or clean up, someone else's rows.
  if (count !== 0) throw new Error('Expected an empty test vocabulary');
  const manifest = buildProductionVocabularyManifest();
  const ids: Parameters<typeof productionVocabularyRows>[0] = {
    families: {},
    definitions: {},
    units: {},
  };
  for (const f of manifest.families) ids.families[f.code] = randomUUID();
  for (const d of manifest.definitions) {
    ids.definitions[d.code] = { id: randomUUID(), type: d.type };
    if ('units' in d)
      for (const u of d.units)
        ids.units[JSON.stringify([d.code, u.code])] = randomUUID();
  }
  const rows = productionVocabularyRows(ids);
  await prisma.$transaction(async (tx) => {
    await tx.editorialFamily.createMany({
      data: rows.families.map(
        ({ id, code, label, minimumContractVersion }) => ({
          id,
          code,
          label,
          minimumContractVersion,
        }),
      ),
    });
    await tx.editorialDefinition.createMany({
      data: rows.definitions.map(
        ({ id, code, label, description, type, numericPolicy }) => ({
          id,
          code,
          label,
          description,
          type,
          numericPolicy: numericPolicy ?? Prisma.DbNull,
        }),
      ),
    });
    await tx.editorialBinding.createMany({
      data: rows.families.flatMap((f) =>
        f.bindings.map((b) => ({
          familyId: b.familyId,
          definitionId: b.definitionId,
          owner: b.owner,
          sortOrder: b.sortOrder,
          exposure: b.exposure,
          searchable: b.searchable,
          publicationCheck: b.publicationCheck,
          policy: b.policy,
        })),
      ),
    });
    await tx.editorialOption.createMany({
      data: rows.definitions.flatMap((d) => d.options),
    });
    await tx.editorialUnit.createMany({
      data: rows.definitions.flatMap((d) => d.units),
    });
    await tx.editorialGroup.createMany({
      data: rows.definitions.flatMap((d) =>
        d.groups.map(({ definitionId, definitionType, code, label }) => ({
          definitionId,
          definitionType,
          code,
          label,
        })),
      ),
    });
    await tx.editorialGroupMember.createMany({
      data: rows.definitions.flatMap((d) => d.groups.flatMap((g) => g.members)),
    });
    await tx.editorialAlias.createMany({
      data: rows.definitions.flatMap((d) => d.aliases),
    });
    await tx.editorialVocabularyMetadata.create({ data: rows.metadata });
  });
}

export async function uninstallVocabulary(prisma: PrismaClient) {
  await prisma.$executeRaw`TRUNCATE TABLE "editorial_aliases",
    "editorial_group_members", "editorial_groups", "editorial_options",
    "editorial_units", "editorial_bindings", "editorial_definitions",
    "editorial_families", "editorial_vocabulary_metadata"`;
}
