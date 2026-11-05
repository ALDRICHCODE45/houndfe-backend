import {
  CHOICES,
  NUMBERS,
  OTHER,
} from './editorial-production-vocabulary-catalog';
import {
  DEFINITION_DESCRIPTIONS,
  DESCRIPTION_MAX_LENGTH,
} from './editorial-production-vocabulary-descriptions';
import { DEFINITION_LABELS } from './editorial-production-vocabulary-labels';

const rows = [...CHOICES, ...NUMBERS, ...OTHER];
const definitionCodes = rows.map(([c]) => c);
const exposureOf = (code: string) => {
  const choice = CHOICES.find(([c]) => c === code);
  if (choice) return choice[2];
  const number = NUMBERS.find(([c]) => c === code);
  if (number) return number[3];
  return OTHER.find(([c]) => c === code)![3];
};
const INTERNAL_NOTE = 'Interno, no se publica';

describe('production vocabulary descriptions (es-MX)', () => {
  it('describes exactly the 68 production definitions', () => {
    expect(definitionCodes).toHaveLength(68);
    expect(Object.keys(DEFINITION_DESCRIPTIONS).sort()).toEqual(
      [...definitionCodes].sort(),
    );
  });

  it('keeps every description one well-formed line within the length budget', () => {
    expect(DESCRIPTION_MAX_LENGTH).toBe(160);
    for (const text of Object.values(DEFINITION_DESCRIPTIONS)) {
      expect(text.length).toBeGreaterThan(0);
      expect(text).toBe(text.normalize('NFC'));
      expect(text).toBe(text.trim());
      expect(text).not.toMatch(/[\r\n\t]/);
      expect(text).not.toMatch(/\s{2,}/);
      expect(text.length).toBeLessThanOrEqual(DESCRIPTION_MAX_LENGTH);
      expect(text).toMatch(/[.)»…]$/);
    }
  });

  it('never repeats the label or the code as the description', () => {
    for (const [code, text] of Object.entries(DEFINITION_DESCRIPTIONS)) {
      expect(text).not.toBe(code);
      expect(text).not.toBe(
        DEFINITION_LABELS[code as keyof typeof DEFINITION_LABELS],
      );
    }
  });

  it('gives every definition its own text', () => {
    const texts = Object.values(DEFINITION_DESCRIPTIONS);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('flags exactly the INTERNAL definitions as «Interno, no se publica»', () => {
    const flagged = Object.entries(DEFINITION_DESCRIPTIONS)
      .filter(([, text]) => text.includes(INTERNAL_NOTE))
      .map(([code]) => code)
      .sort();
    const expected = definitionCodes
      .filter((code) => exposureOf(code) === 'I')
      .sort();
    expect(expected).toEqual([
      'text.clinical_analysis',
      'text.concentration',
      'text.regulatory_warnings',
    ]);
    expect(flagged).toEqual(expected);
    for (const code of expected)
      expect(
        DEFINITION_DESCRIPTIONS[code as keyof typeof DEFINITION_DESCRIPTIONS],
      ).toMatch(/Interno, no se publica\.$/);
  });

  it('pins the frontend example verbatim', () => {
    expect(DEFINITION_DESCRIPTIONS['text.clinical_analysis']).toBe(
      'Análisis de la etiqueta del fabricante (proteína, grasa, fibra…). Interno, no se publica.',
    );
  });

  it('states the domain facts that are easy to get wrong', () => {
    const d = DEFINITION_DESCRIPTIONS;
    // Content count is a count of things inside, never stock; dose_unit never doses.
    expect(d['measure.content_count']).toMatch(/no es stock/);
    expect(d['measure.content_count']).toMatch(/Dosis/);
    expect(d['measure.content_count']).toMatch(/no indica cuánto dar/);
    // pack_count counts interior units, never stock.
    expect(d['measure.pack_count']).toMatch(/dentro/);
    expect(d['measure.pack_count']).toMatch(/no es stock/);
    // Content measures name the magnitude they belong to.
    expect(d['measure.net_mass']).toMatch(/Masa/);
    expect(d['measure.net_volume']).toMatch(/Volumen/);
    expect(d['measure.content_count']).toMatch(/Conteo/);
    expect(d['measure.coverage.length']).toMatch(/Longitud/);
    expect(d['measure.coverage.area']).toMatch(/Superficie/);
    // Capacity is not net content; interior never replaces exterior.
    expect(d['measure.capacity.container']).toMatch(/no es el contenido neto/);
    expect(d['measure.dimensions.internal_length']).toMatch(/No sustituye/);
    expect(d['measure.dimensions.external_length']).toMatch(/No sustituye/);
    // Fit ranges never stand in for a size label; animal mass is not species.
    expect(d['measure.fit.neck']).toMatch(/no reemplaza la talla/i);
    expect(d['measure.animal_mass']).toMatch(/no define la especie/);
  });

  it('does not invent health claims', () => {
    const claims =
      /hipoalerg|renal|antiparasit|dental|cura\b|previene|trata\b|alivia|terap|dosifica(?!ción)/i;
    for (const text of Object.values(DEFINITION_DESCRIPTIONS))
      expect(text).not.toMatch(claims);
  });
});
