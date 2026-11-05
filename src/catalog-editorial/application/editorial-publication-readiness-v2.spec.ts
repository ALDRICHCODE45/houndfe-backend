import type { PublicationProblemV2 } from '../domain/editorial-publication-readiness-v2';
import {
  READINESS_MESSAGES,
  presentPublicationReadinessV2 as present,
} from './editorial-publication-readiness-v2';

const definitions = [
  { code: 'measure.net_mass', label: 'Peso neto' },
  { code: 'animal.target', label: 'Especie' },
  { code: 'text.ingredients', label: 'Ingredientes' },
  { code: 'food.format', label: 'Croqueta o lata' },
  { code: 'custom.color', label: 'Color de etiqueta' },
];
const meta = {
  cycle: 3,
  draftRevision: 12,
  vocabularyRevision: 'ev2-sha256-' + 'a'.repeat(64),
};
const p = (
  problem: PublicationProblemV2['problem'],
  definitionCode: string | null = null,
  scope: PublicationProblemV2['scope'] = definitionCode
    ? 'definition'
    : 'product',
  detail: string | null = null,
  variantId: string | null = null,
): PublicationProblemV2 => ({
  scope,
  definitionCode,
  variantId,
  problem,
  detail,
});
const run = (problems: PublicationProblemV2[], familyCode = 'food') =>
  present({ problems, familyCode, definitions, ...meta });

describe('presentPublicationReadinessV2', () => {
  it('is ready only with no items, and echoes the evaluated state', () => {
    expect(run([])).toEqual({
      ready: true,
      ...meta,
      items: [],
      bySection: {},
    });
  });

  it('matches the agreed FE example shape exactly', () => {
    expect(
      run([
        p('NO_OFFERED_PRESENTATION'),
        p('REQUIRED_MISSING', 'measure.net_mass'),
        p('EVIDENCE_REQUIRED', 'animal.target'),
      ]),
    ).toEqual({
      ready: false,
      ...meta,
      items: [
        {
          scope: 'product',
          definitionCode: null,
          variantId: null,
          sectionCode: null,
          problem: 'NO_OFFERED_PRESENTATION',
          message:
            'El producto no se ofrece en ninguna lista de precios en línea.',
        },
        {
          scope: 'definition',
          definitionCode: 'measure.net_mass',
          variantId: null,
          sectionCode: 'contenido-empaque',
          problem: 'REQUIRED_MISSING',
          message: 'Falta el peso neto.',
        },
        {
          scope: 'definition',
          definitionCode: 'animal.target',
          variantId: null,
          sectionCode: 'para-quien',
          problem: 'EVIDENCE_REQUIRED',
          message: 'Agrega de dónde sale este dato.',
        },
      ],
      bySection: { 'contenido-empaque': 1, 'para-quien': 1 },
    });
  });

  it('names the missing field with its article and plural', () => {
    const [mass, species, ingredients] = run([
      p('REQUIRED_MISSING', 'measure.net_mass'),
      p('REQUIRED_MISSING', 'animal.target'),
      p('REQUIRED_MISSING', 'text.ingredients'),
    ]).items;
    expect(mass.message).toBe('Falta el peso neto.');
    expect(species.message).toBe('Falta la especie.');
    expect(ingredients.message).toBe('Faltan los ingredientes.');
  });

  it('quotes customized or custom labels instead of guessing an article', () => {
    const [custom, renamed] = run(
      [
        p('REQUIRED_MISSING', 'custom.color'),
        p('REQUIRED_MISSING', 'food.format'),
      ],
      'custom',
    ).items;
    expect(custom).toMatchObject({
      sectionCode: null,
      message: 'Completa «Color de etiqueta».',
    });
    expect(renamed.message).toBe('Completa «Croqueta o lata».');
  });

  it('gives each product field and care gap its own copy', () => {
    const items = run([
      p('REQUIRED_MISSING', null, 'product', 'commercialTitle'),
      p('REQUIRED_MISSING', null, 'product', 'familyCode'),
      p('CARE_REVIEW_INCOMPLETE', null, 'care', 'WARNING_PUBLIC', 'v1'),
      p('FACTS_CONFLICT', null, 'variant', null, 'v1'),
    ]).items;
    expect(items.map((i) => i.message)).toEqual([
      'Falta el título comercial.',
      'Elige el tipo de producto.',
      READINESS_MESSAGES.care.WARNING_PUBLIC,
      READINESS_MESSAGES.variant.FACTS_CONFLICT,
    ]);
    expect(items.map((i) => [i.sectionCode, i.variantId])).toEqual([
      [null, null],
      [null, null],
      [null, 'v1'],
      [null, 'v1'],
    ]);
    expect(run(items.length ? [] : []).bySection).toEqual({});
  });

  it('has an es-MX tú message for every problem and care gap', () => {
    const all = Object.values(READINESS_MESSAGES).flatMap((group) =>
      Object.values(group),
    );
    expect(all.length).toBeGreaterThan(15);
    for (const message of all) {
      expect(message).toMatch(/^[A-ZÁÉÍÓÚ¿].*[.?]$/);
      expect(message).not.toMatch(/\b(usted|vos|ingrese|agregue)\b/i);
    }
  });
});
