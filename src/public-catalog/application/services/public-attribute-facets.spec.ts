import {
  countFacets,
  matchFacetSelection,
  toFacetSelection,
  unknownFacetSelection,
  type FacetCandidate,
  type FacetDefinitions,
} from './public-attribute-facets';

const definitions: FacetDefinitions = new Map([
  [
    'animal',
    {
      label: 'Especie',
      options: new Map([
        ['dog', 'Perro'],
        ['cat', 'Gato'],
      ]),
    },
  ],
  [
    'texture',
    {
      label: 'Textura',
      options: new Map([
        ['dry', 'Seca'],
        ['moist', 'Húmeda'],
      ]),
    },
  ],
]);

const subject = (animal: string[], texture: string[]) =>
  new Map([
    ['animal', new Set(animal)],
    ['texture', new Set(texture)],
  ]);

const candidates: FacetCandidate[] = [
  { id: 'A', subjects: [subject(['dog'], ['dry'])] },
  { id: 'B', subjects: [subject(['cat'], ['moist'])] },
  // dog on one variant, dry on another: never a dog+dry match.
  {
    id: 'V',
    subjects: [subject(['dog'], ['moist']), subject(['cat'], ['dry'])],
  },
];

const select = (entries: [string, string[]][]) =>
  toFacetSelection(entries.map(([code, options]) => ({ code, options })));

describe('public attribute facets', () => {
  it('ORs options within a definition', () => {
    expect(
      matchFacetSelection(candidates, select([['animal', ['dog', 'cat']]])),
    ).toEqual(['A', 'B', 'V']);
  });

  it('ANDs definitions on one subject (correlated variant matching)', () => {
    expect(
      matchFacetSelection(
        candidates,
        select([
          ['animal', ['dog']],
          ['texture', ['dry']],
        ]),
      ),
    ).toEqual(['A']);
  });

  it('an empty selection matches every product with a subject', () => {
    expect(
      matchFacetSelection(
        [...candidates, { id: 'none', subjects: [] }],
        new Map(),
      ),
    ).toEqual(['A', 'B', 'V']);
  });

  it('counts unique products per option excluding the facet own selection', () => {
    expect(
      countFacets(
        candidates,
        select([
          ['animal', ['dog']],
          ['texture', ['dry']],
        ]),
        definitions,
      ),
    ).toEqual([
      {
        code: 'animal',
        label: 'Especie',
        // texture=dry applied: A(dog), V.v1(cat)
        options: [
          { code: 'cat', label: 'Gato', count: 1 },
          { code: 'dog', label: 'Perro', count: 1 },
        ],
      },
      {
        code: 'texture',
        label: 'Textura',
        // animal=dog applied: A(dry), V.v0(moist)
        options: [
          { code: 'moist', label: 'Húmeda', count: 1 },
          { code: 'dry', label: 'Seca', count: 1 },
        ],
      },
    ]);
  });

  it('a product counts once per option even when several variants hold it', () => {
    const [facet] = countFacets(
      [{ id: 'W', subjects: [subject(['dog'], []), subject(['dog'], [])] }],
      new Map(),
      definitions,
    );
    expect(facet.options).toEqual([{ code: 'dog', label: 'Perro', count: 1 }]);
  });

  it('keeps selected options with count 0 and drops unknown codes', () => {
    const facets = countFacets(
      [{ id: 'X', subjects: [new Map([['other', new Set(['x'])]])] }],
      select([['texture', ['moist']]]),
      definitions,
    );
    expect(facets).toEqual([
      {
        code: 'texture',
        label: 'Textura',
        options: [{ code: 'moist', label: 'Húmeda', count: 0 }],
      },
    ]);
  });

  it('reports the first unknown definition or option', () => {
    expect(
      unknownFacetSelection(select([['animal', ['dog']]]), definitions),
    ).toBe(null);
    expect(unknownFacetSelection(select([['nope', ['x']]]), definitions)).toBe(
      'nope',
    );
    expect(
      unknownFacetSelection(select([['animal', ['dragon']]]), definitions),
    ).toBe('animal:dragon');
  });
});
