import {
  CHOICES,
  FAMILY_CODES,
  NUMBERS,
  OTHER,
} from './editorial-production-vocabulary-catalog';
import {
  DEFINITION_LABELS,
  FAMILY_LABELS,
  UNIT_LABELS,
} from './editorial-production-vocabulary-labels';

const definitionCodes = [...CHOICES, ...NUMBERS, ...OTHER].map(([c]) => c);
const unitCodes = NUMBERS.flatMap(([, , units]) => units.split(','));
const wellFormed = (label: string) =>
  label === label.normalize('NFC') &&
  label === label.trim() &&
  label.length > 0 &&
  label.length <= 40;

describe('production vocabulary display labels (es-MX)', () => {
  it('labels exactly the seven families, none equal to its code', () => {
    expect(Object.keys(FAMILY_LABELS).sort()).toEqual([...FAMILY_CODES].sort());
    for (const [code, label] of Object.entries(FAMILY_LABELS)) {
      expect(label).not.toBe(code);
      expect(wellFormed(label)).toBe(true);
    }
    expect(new Set(Object.values(FAMILY_LABELS)).size).toBe(
      FAMILY_CODES.length,
    );
  });

  it('labels exactly the 68 definitions, none equal to its code', () => {
    expect(definitionCodes).toHaveLength(68);
    expect(Object.keys(DEFINITION_LABELS).sort()).toEqual(
      [...definitionCodes].sort(),
    );
    for (const [code, label] of Object.entries(DEFINITION_LABELS)) {
      expect(label).not.toBe(code);
      expect(wellFormed(label)).toBe(true);
    }
  });

  it('keeps definition labels unique so tables never show two identical rows', () => {
    const labels = Object.values(DEFINITION_LABELS);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('pins the labels requested by the frontend', () => {
    expect(FAMILY_LABELS.food).toBe('Alimento');
    expect(DEFINITION_LABELS['animal.target']).toBe('Especie');
    expect(DEFINITION_LABELS['life.stage']).toBe('Etapa de vida');
    expect(DEFINITION_LABELS['size.animal']).toBe('Tamaño de raza');
    expect(DEFINITION_LABELS['measure.net_mass']).toBe('Peso neto');
  });

  it('labels only units that are words; symbolic units keep their code', () => {
    const units = new Set(unitCodes);
    for (const [code, label] of Object.entries(UNIT_LABELS)) {
      expect(units.has(code)).toBe(true);
      expect(label).not.toBe(code);
      expect(wellFormed(label)).toBe(true);
    }
    const wordUnits = [...units].filter((u) => /^[a-z_]{3,}$/.test(u));
    expect(Object.keys(UNIT_LABELS).sort()).toEqual(wordUnits.sort());
  });
});
