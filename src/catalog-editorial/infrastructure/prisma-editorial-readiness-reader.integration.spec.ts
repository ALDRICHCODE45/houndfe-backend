import { Prisma, type PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { buildProductionVocabularyManifest } from '../../../prisma/editorial-production-vocabulary.manifest';
import { productionVocabularyRows } from '../../../prisma/editorial-production-vocabulary-rows';
import {
  disconnectIntegrationPrisma,
  integrationPrisma,
} from '../../../test/integration/reset-db';
import { readEditorialVocabulary } from '../application/editorial-vocabulary-read';
import { PrismaEditorialReadinessReader } from './prisma-editorial-readiness-reader';
import { PrismaEditorialVocabularySnapshot } from './prisma-editorial-vocabulary-snapshot';

// Real PostgreSQL, real production vocabulary, real V2 drafts per family.
const evidence = {
  sourceRef: 'Etiqueta del empaque',
  verifiedOn: '2026-11-01',
};
const actorId = randomUUID();
const tenantId = randomUUID();
const globalPriceListId = randomUUID();

let prisma: PrismaClient;
let revision: string;
let reader: PrismaEditorialReadinessReader;

type Value = Record<string, unknown>;
const known = (code: string, payload: Value, withEvidence = true): Value => ({
  code,
  owner: 'sellable',
  variantId: null,
  state: 'known',
  payload,
  evidence: withEvidence ? evidence : null,
});
const fact = (key: string, value: unknown) => ({
  key,
  state: 'known',
  value,
  evidence,
  basis: 'Dice el empaque',
});
function food(values = foodValues()) {
  return {
    schemaVersion: 2,
    commercialTitle: 'Croquetas para perro adulto 2 kg',
    description: null,
    mediaRefs: [],
    familyCode: 'food',
    values,
    facts: [
      {
        variantId: null,
        presentation: 'Bolsa de 2 kg',
        declarations: [fact('contentMagnitude', 'mass')],
        careReview: null,
      },
    ],
  };
}
function foodValues(): Value[] {
  return [
    known('animal.target', { type: 'multi', value: ['ani.dom.dog'] }),
    known('food.format', { type: 'single', value: 'food.format.kibble' }),
    known('measure.net_mass', { type: 'number', value: 2, unit: 'kg' }),
  ];
}
function care(careReview: unknown) {
  return {
    schemaVersion: 2,
    commercialTitle: 'Limpiador ótico 120 ml',
    description: null,
    mediaRefs: [],
    familyCode: 'care',
    values: [
      known('care.type', { type: 'single', value: 'care.type.grooming' }),
      known('care.form', { type: 'single', value: 'care.form.solution' }),
      known('measure.net_volume', { type: 'number', value: 120, unit: 'ml' }),
    ],
    facts: [
      {
        variantId: null,
        presentation: 'Frasco de 120 ml',
        declarations: [
          fact('contentMagnitude', 'volume'),
          fact('presentationKind', 'formulation'),
        ],
        careReview,
      },
    ],
  };
}

/** A simple product offered on the tenant catalog list unless told otherwise. */
async function product(
  draft: unknown,
  { offered = true }: { offered?: boolean } = {},
): Promise<string> {
  const productId = randomUUID();
  await prisma.product.create({
    data: {
      id: productId,
      tenantId,
      name: 'Producto ' + productId.slice(0, 8),
      includeInOnlineCatalog: offered,
    },
  });
  await prisma.priceList.create({
    data: { tenantId, productId, globalPriceListId, priceCents: 25000 },
  });
  if (draft !== undefined)
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "catalog_editorial_states"
        ("tenantId", "productId", "cycle", "draftRevision", "draftDocument")
      VALUES (${tenantId}, ${productId}, 1, 4, CAST(${JSON.stringify(draft)} AS JSONB))`);
  return productId;
}
const read = (productId: string, vocabularyRevision = revision) =>
  reader.read({ actorId, tenantId, productId }, vocabularyRevision);

/**
 * The 68 canonical production rows, as the install helper writes them (that
 * helper cannot run under Jest: its structuredClone yields cross-realm objects
 * that canonical JSON rejects). No starter family is needed here.
 */
async function installCanonicalVocabulary(): Promise<void> {
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

beforeAll(async () => {
  prisma = integrationPrisma();
  const [{ count }] = await prisma.$queryRaw<{ count: number }[]>(
    Prisma.sql`SELECT count(*)::int AS count FROM "editorial_families"`,
  );
  // Vocabulary is global: never install over, or clean up, someone else's rows.
  if (count !== 0) throw new Error('Expected an empty test vocabulary');
  await installCanonicalVocabulary();
  revision = (
    await readEditorialVocabulary(new PrismaEditorialVocabularySnapshot(prisma))
  ).vocabularyRevision;
  await prisma.tenant.create({
    data: { id: tenantId, name: 'Readiness', slug: 'readiness-' + tenantId },
  });
  await prisma.globalPriceList.create({
    data: { id: globalPriceListId, name: 'Readiness ' + globalPriceListId },
  });
  await prisma.tenantCatalogPriceList.create({
    data: { tenantId, globalPriceListId },
  });
  reader = new PrismaEditorialReadinessReader(prisma);
}, 60_000);

afterAll(async () => {
  try {
    await prisma.$executeRaw(
      Prisma.sql`DELETE FROM "catalog_editorial_states" WHERE "tenantId" = ${tenantId}`,
    );
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.globalPriceList.deleteMany({
      where: { id: globalPriceListId },
    });
    await prisma.$executeRaw`TRUNCATE TABLE "editorial_aliases",
      "editorial_group_members", "editorial_groups", "editorial_options",
      "editorial_units", "editorial_bindings", "editorial_definitions",
      "editorial_families", "editorial_vocabulary_metadata"`;
  } finally {
    await disconnectIntegrationPrisma();
  }
});

describe('readiness of saved V2 drafts on PostgreSQL', () => {
  it('food: a complete draft is ready', async () => {
    const result = await read(await product(food()));
    expect(result).toEqual({
      ready: true,
      cycle: 1,
      draftRevision: 4,
      vocabularyRevision: revision,
      items: [],
      bySection: {},
    });
  });

  it('food: missing net mass names the field and its section', async () => {
    const values = foodValues().filter((v) => v.code !== 'measure.net_mass');
    const result = await read(await product(food(values)));
    expect(result.ready).toBe(false);
    expect(result.items).toEqual([
      {
        scope: 'definition',
        definitionCode: 'measure.net_mass',
        variantId: null,
        sectionCode: 'contenido-empaque',
        problem: 'REQUIRED_MISSING',
        message: 'Falta el peso neto.',
      },
    ]);
    expect(result.bySection).toEqual({ 'contenido-empaque': 1 });
  });

  it('food: N/A on a required definition is not allowed', async () => {
    const values = foodValues();
    values[0] = { ...values[0], state: 'not_applicable', evidence: null };
    delete values[0].payload;
    const result = await read(await product(food(values)));
    expect(result.items).toEqual([
      expect.objectContaining({
        definitionCode: 'animal.target',
        sectionCode: 'para-quien',
        problem: 'NA_NOT_ALLOWED',
      }),
    ]);
  });

  it('food: a known value without evidence asks for its source', async () => {
    const values = foodValues();
    values[1] = { ...values[1], evidence: null };
    const result = await read(await product(food(values)));
    expect(result.items).toEqual([
      expect.objectContaining({
        definitionCode: 'food.format',
        sectionCode: 'que-es',
        problem: 'EVIDENCE_REQUIRED',
        message: 'Agrega de dónde sale este dato.',
      }),
    ]);
  });

  it('food: a product not offered online has an empty E', async () => {
    const result = await read(await product(food(), { offered: false }));
    expect(result.items).toEqual([
      {
        scope: 'product',
        definitionCode: null,
        variantId: null,
        sectionCode: null,
        problem: 'NO_OFFERED_PRESENTATION',
        message:
          'El producto no se ofrece en ninguna lista de precios en línea.',
      },
    ]);
    expect(result.bySection).toEqual({});
  });

  it('care: an unprepared review blocks with a care item', async () => {
    const result = await read(await product(care({ state: 'unknown' })));
    expect(result.items).toEqual([
      {
        scope: 'care',
        definitionCode: null,
        variantId: null,
        sectionCode: null,
        problem: 'CARE_REVIEW_INCOMPLETE',
        message: 'Completa la revisión de cuidado de esta presentación.',
      },
    ]);
  });

  it('care: a ready review is ready', async () => {
    const review = {
      state: 'prepared',
      jurisdiction: 'MX',
      intendedUse: 'Limpieza de oídos',
      determination: 'none_applicable',
      evidence: [evidence],
      basis: 'Producto cosmético sin requisitos sanitarios',
      requirements: [],
      warnings: [],
    };
    expect((await read(await product(care(review)))).ready).toBe(true);
  });

  it('no draft: 200 with a single product item', async () => {
    const result = await read(await product(undefined));
    expect(result).toEqual({
      ready: false,
      cycle: null,
      draftRevision: null,
      vocabularyRevision: revision,
      items: [
        expect.objectContaining({ scope: 'product', problem: 'NO_DRAFT' }),
      ],
      bySection: {},
    });
  });

  it('is read-only and pins the vocabulary revision', async () => {
    const productId = await product(food());
    const snapshot = () =>
      prisma.$queryRaw(Prisma.sql`
        SELECT to_jsonb(s) AS state FROM "catalog_editorial_states" s
        WHERE "tenantId" = ${tenantId} ORDER BY "productId"`);
    const before = await snapshot();
    await read(productId);
    await expect(
      read(productId, 'ev2-sha256-' + '0'.repeat(64)),
    ).rejects.toThrow('VOCABULARY_CHANGED');
    await expect(read(randomUUID())).rejects.toThrow('NOT_FOUND');
    expect(await snapshot()).toEqual(before);
  });
});
