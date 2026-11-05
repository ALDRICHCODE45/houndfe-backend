import { Prisma, type PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  disconnectIntegrationPrisma,
  integrationPrisma,
} from '../../../test/integration/reset-db';
import { readEditorialVocabulary } from '../application/editorial-vocabulary-read';
import { PrismaEditorialReadinessReader } from './prisma-editorial-readiness-reader';
import { PrismaEditorialVocabularySnapshot } from './prisma-editorial-vocabulary-snapshot';
import {
  installCanonicalVocabulary,
  readyDrafts,
  uninstallVocabulary,
} from './test-support/editorial-publication-postgres';

// Real PostgreSQL, real production vocabulary, real V2 drafts per family.
const evidence = {
  sourceRef: 'Etiqueta del empaque',
  verifiedOn: '2026-11-01',
};
const actorId = randomUUID();
const tenantId = randomUUID();
const globalPriceListId = randomUUID();

let prisma: PrismaClient;
let installed = false;
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

beforeAll(async () => {
  prisma = integrationPrisma();
  await installCanonicalVocabulary(prisma);
  installed = true;
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
  } finally {
    try {
      // Never truncate a vocabulary this spec did not install.
      if (installed) await uninstallVocabulary(prisma);
    } finally {
      await disconnectIntegrationPrisma();
    }
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

  // S88 «Es solo equipamiento» is not implemented: it is an extra exception,
  // not a gate, so a habitat with declared space/equipment facts is ready.
  it('habitat: a complete draft is ready without S88', async () => {
    expect(await read(await product(readyDrafts.habitat()))).toMatchObject({
      ready: true,
      items: [],
    });
  });

  it('habitat: a declared dimension without a value is missing', async () => {
    const draft = readyDrafts.habitat();
    draft.values = draft.values.filter(
      (v) => v.code !== 'measure.dimensions.external_height',
    );
    const result = await read(await product(draft));
    expect(result.items).toEqual([
      {
        scope: 'definition',
        definitionCode: 'measure.dimensions.external_height',
        variantId: null,
        sectionCode: 'medidas',
        problem: 'REQUIRED_MISSING',
        message: 'Falta el alto exterior.',
      },
    ]);
    expect(result.bySection).toEqual({ medidas: 1 });
  });

  // D8 (b): collar, harness and leash default an unknown capacity to «No».
  const withoutCapacityOrElectrical = (type: string) => {
    const draft = readyDrafts.accessory();
    draft.values = [
      known('accessory.type', {
        type: 'single',
        value: `accessory.type.${type}`,
      }),
    ];
    draft.facts[0].declarations = draft.facts[0].declarations.filter((d) =>
      ['fitDeterminesChoice', 'relevantFitCodes'].includes(
        (d as { key: string }).key,
      ),
    );
    return draft;
  };

  it('accessory: a collar is ready without capacity or electrical declarations', async () => {
    const draft = withoutCapacityOrElectrical('collar');
    const productId = await product(draft);
    expect(await read(productId)).toMatchObject({ ready: true, items: [] });
    const [{ document }] = await prisma.$queryRaw<{ document: unknown }[]>(
      Prisma.sql`SELECT "draftDocument" AS document FROM "catalog_editorial_states"
        WHERE "tenantId" = ${tenantId} AND "productId" = ${productId}`,
    );
    expect(document).toEqual(draft);
  });

  it('accessory: a bowl without the capacity declaration stays unresolved', async () => {
    const result = await read(
      await product(withoutCapacityOrElectrical('bowl')),
    );
    expect(result.ready).toBe(false);
    expect(result.items).toEqual([
      expect.objectContaining({
        scope: 'definition',
        definitionCode: 'measure.capacity.container',
        problem: 'UNRESOLVED',
      }),
    ]);
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
