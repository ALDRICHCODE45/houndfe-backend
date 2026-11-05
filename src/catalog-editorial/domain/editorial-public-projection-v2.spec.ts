import {
  projectPublishedEditorialV2,
  type PublicVocabularyBindingV2,
  type PublicVocabularyV2,
} from './editorial-public-projection-v2';

const evidence = { sourceRef: 'Etiqueta privada', verifiedOn: '2026-11-01' };

function binding(
  definitionCode: string,
  type: string,
  extra: Partial<PublicVocabularyBindingV2> = {},
): [string, PublicVocabularyBindingV2] {
  return [
    definitionCode,
    {
      definitionCode,
      label: 'L ' + definitionCode,
      type,
      exposure: 'DETAIL',
      sortOrder: 0,
      options: new Map(),
      units: new Map(),
      ...extra,
    },
  ];
}

const vocabulary: PublicVocabularyV2 = new Map([
  [
    'accessory',
    new Map([
      binding('feature.washable', 'boolean', { sortOrder: 2 }),
      binding('measure.fit.neck', 'range', {
        exposure: 'FACET',
        units: new Map([['cm', null]]),
      }),
      binding('measure.content_count', 'number', {
        units: new Map([['piece', 'Pieza']]),
      }),
      binding('accessory.type', 'single', {
        exposure: 'FACET',
        options: new Map([['accessory.type.collar', 'Collar']]),
      }),
      binding('color.base', 'multi', {
        options: new Map([['color.red', 'Rojo']]),
      }),
      binding('custom.code', 'number', { sortOrder: 1 }),
    ]),
  ],
]);

const value = (
  code: string,
  payload: unknown,
  variantId: string | null = null,
) => ({
  code,
  owner: 'sellable',
  variantId,
  state: 'known',
  payload,
  evidence,
});

function document(values: unknown[], familyCode: string | null = 'accessory') {
  return {
    schemaVersion: 2,
    commercialTitle: 'Collar rojo',
    description: 'Collar ajustable',
    mediaRefs: ['private-media-ref'],
    familyCode,
    values,
    facts: [
      {
        variantId: null,
        presentation: 'Pieza',
        declarations: [],
        careReview: null,
      },
    ],
  };
}

describe('projectPublishedEditorialV2', () => {
  it('projects known public values with labels, in section then binding order', () => {
    const projection = projectPublishedEditorialV2(
      document([
        value('custom.code', { type: 'number', value: 3, unit: null }),
        value('feature.washable', { type: 'boolean', value: false }),
        value('measure.fit.neck', {
          type: 'range',
          min: 30,
          max: 45.5,
          unit: 'cm',
        }),
        value('measure.content_count', {
          type: 'number',
          value: 2,
          unit: 'piece',
        }),
        value('accessory.type', {
          type: 'single',
          value: 'accessory.type.collar',
        }),
      ]),
      vocabulary,
    );
    expect(projection.commercialTitle).toBe('Collar rojo');
    expect(projection.description).toBe('Collar ajustable');
    expect(
      projection.attributes.map((a) => [
        a.code,
        a.section?.code ?? null,
        a.display,
        a.facet,
      ]),
    ).toEqual([
      ['accessory.type', 'que-es', 'Collar', true],
      ['feature.washable', 'caracteristicas', 'No', false],
      ['measure.fit.neck', 'medidas-ajuste', '30–45.5 cm', true],
      ['measure.content_count', 'contenido-empaque', '2 Pieza', false],
      ['custom.code', null, '3', false],
    ]);
    expect(projection.attributes[2].value).toEqual({
      type: 'range',
      min: 30,
      max: 45.5,
      unit: { code: 'cm', label: 'cm' },
    });
    const serialized = JSON.stringify(projection.attributes);
    for (const secret of ['Etiqueta privada', 'private-media-ref'])
      expect(serialized).not.toContain(secret);
  });

  it('leaves out non-public definitions, unknown options/units, type mismatches and non-known states', () => {
    const projection = projectPublishedEditorialV2(
      document([
        value('text.clinical_analysis', { type: 'text', value: 'interno' }),
        value('accessory.type', {
          type: 'single',
          value: 'accessory.type.unknown',
        }),
        value('color.base', { type: 'multi', value: ['color.blue'] }),
        value('measure.content_count', {
          type: 'number',
          value: 2,
          unit: 'kg',
        }),
        value('feature.washable', { type: 'text', value: 'sí' }),
        {
          code: 'feature.washable',
          owner: 'sellable',
          variantId: null,
          state: 'unknown',
          evidence: null,
        },
        {
          code: 'measure.fit.neck',
          owner: 'sellable',
          variantId: null,
          state: 'not_applicable',
          evidence: null,
        },
      ]),
      vocabulary,
    );
    expect(projection.attributes).toEqual([]);
  });

  it('keeps known options of a multi value and groups sellable values per variant', () => {
    const projection = projectPublishedEditorialV2(
      document([
        value(
          'color.base',
          { type: 'multi', value: ['color.blue', 'color.red'] },
          'v1',
        ),
        value('feature.washable', { type: 'boolean', value: true }, 'v2'),
      ]),
      vocabulary,
    );
    expect(projection.attributes).toEqual([]);
    expect(projection.variantAttributes.get('v1')).toEqual([
      expect.objectContaining({
        value: {
          type: 'multi',
          options: [{ code: 'color.red', label: 'Rojo' }],
        },
        display: 'Rojo',
      }),
    ]);
    expect(projection.variantAttributes.get('v2')?.[0].display).toBe('Sí');
  });

  it('has no attributes without a family and rejects a non-V2 document', () => {
    expect(
      projectPublishedEditorialV2(
        document(
          [value('feature.washable', { type: 'boolean', value: true })],
          null,
        ),
        vocabulary,
      ).attributes,
    ).toEqual([]);
    expect(() =>
      projectPublishedEditorialV2({ schemaVersion: 2 }, vocabulary),
    ).toThrow();
  });
});
