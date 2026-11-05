import { buildProductionVocabularyManifest } from '../../../prisma/editorial-production-vocabulary.manifest';
import { FAMILY_CODES } from './editorial-production-vocabulary-catalog';
import { DEFINITION_LABELS } from './editorial-production-vocabulary-labels';
import {
  FAMILY_SECTIONS,
  SECTION_LABELS,
} from './editorial-production-vocabulary-sections';

const manifest = buildProductionVocabularyManifest();
const wellFormed = (label: string) =>
  label === label.normalize('NFC') &&
  label === label.trim() &&
  label.length > 0 &&
  label.length <= 40;

describe('production vocabulary sections (es-MX)', () => {
  it('sections exactly the seven production families', () => {
    expect(Object.keys(FAMILY_SECTIONS).sort()).toEqual(
      [...FAMILY_CODES].sort(),
    );
  });

  it.each([...FAMILY_CODES])(
    'places every %s binding in exactly one section and nothing else',
    (family) => {
      const bound = manifest.families
        .find(({ code }) => code === family)!
        .bindings.map(({ definitionCode }) => definitionCode);
      const sectioned = FAMILY_SECTIONS[family].flatMap(
        ({ definitionCodes }) => definitionCodes,
      );
      expect(new Set(sectioned).size).toBe(sectioned.length);
      expect([...sectioned].sort()).toEqual([...bound].sort());
    },
  );

  it('has no empty or repeated section within a family', () => {
    for (const sections of Object.values(FAMILY_SECTIONS)) {
      const codes = sections.map(({ code }) => code);
      expect(new Set(codes).size).toBe(codes.length);
      for (const { definitionCodes } of sections)
        expect(definitionCodes.length).toBeGreaterThan(0);
    }
  });

  it('uses kebab-case codes with one well-formed, unique label each', () => {
    const used = new Set(
      Object.values(FAMILY_SECTIONS).flatMap((s) => s.map(({ code }) => code)),
    );
    expect(Object.keys(SECTION_LABELS).sort()).toEqual([...used].sort());
    for (const [code, label] of Object.entries(SECTION_LABELS)) {
      expect(code).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(wellFormed(label)).toBe(true);
      // Sentence case: only the first letter may be upper case.
      expect(label.slice(1)).toBe(label.slice(1).toLowerCase());
    }
    const labels = Object.values(SECTION_LABELS);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('pins the food sections requested by the frontend', () => {
    expect(
      FAMILY_SECTIONS.food.map(({ code, definitionCodes }) => [
        SECTION_LABELS[code],
        definitionCodes.map((c) => DEFINITION_LABELS[c]),
      ]),
    ).toEqual([
      [
        'Para quién',
        ['Especie', 'Etapa de vida', 'Tamaño de mascota', 'Peso de la mascota'],
      ],
      [
        'Qué es',
        [
          'Formato del alimento',
          'Función del alimento',
          'Textura',
          'Procesamiento',
          'Origen de la proteína',
          'Comportamiento en el agua',
        ],
      ],
      ['Fórmula', ['Ingredientes', 'Composición', 'Análisis clínico']],
      [
        'Contenido y empaque',
        [
          'Tipo de contenido',
          'Peso neto',
          'Volumen neto',
          'Cantidad contenida',
          'Unidades por paquete',
          'Tipo de envase',
          'Formato de venta',
        ],
      ],
      ['Uso', ['Instrucciones de uso']],
    ]);
  });

  it('is deeply frozen', () => {
    expect(Object.isFrozen(SECTION_LABELS)).toBe(true);
    expect(Object.isFrozen(FAMILY_SECTIONS)).toBe(true);
    for (const sections of Object.values(FAMILY_SECTIONS)) {
      expect(Object.isFrozen(sections)).toBe(true);
      for (const section of sections) {
        expect(Object.isFrozen(section)).toBe(true);
        expect(Object.isFrozen(section.definitionCodes)).toBe(true);
      }
    }
  });
});
