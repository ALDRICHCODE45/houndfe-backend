import {
  facetValuesBySubjectV2,
  type PublicFacetVocabularyV2,
} from './editorial-public-facets-v2';

const vocabulary: PublicFacetVocabularyV2 = {
  definitions: new Map([
    [
      'animal.target',
      {
        label: 'Especie',
        options: new Map([
          ['ani.dom.dog', 'Perro'],
          ['ani.dom.cat', 'Gato'],
        ]),
      },
    ],
    [
      'food.format',
      {
        label: 'Formato',
        options: new Map([['food.format.kibble', 'Croquetas']]),
      },
    ],
  ]),
  byFamily: new Map([
    ['food', new Set(['animal.target', 'food.format'])],
    ['toy', new Set(['animal.target'])],
  ]),
};

const plain = (values: ReadonlyMap<string, ReadonlySet<string>>) =>
  Object.fromEntries([...values].map(([code, set]) => [code, [...set]]));

describe('facetValuesBySubjectV2', () => {
  it('merges product values into each variant and keeps variants apart', () => {
    const values = facetValuesBySubjectV2(
      {
        familyCode: 'food',
        choices: [
          {
            code: 'food.format',
            variantId: null,
            options: ['food.format.kibble'],
          },
          { code: 'animal.target', variantId: 'v1', options: ['ani.dom.dog'] },
          { code: 'animal.target', variantId: 'v2', options: ['ani.dom.cat'] },
        ],
      },
      vocabulary,
    );
    expect(plain(values('v1'))).toEqual({
      'food.format': ['food.format.kibble'],
      'animal.target': ['ani.dom.dog'],
    });
    expect(plain(values('v2'))).toEqual({
      'food.format': ['food.format.kibble'],
      'animal.target': ['ani.dom.cat'],
    });
    expect(plain(values('unknown-variant'))).toEqual({
      'food.format': ['food.format.kibble'],
    });
    expect(plain(values(null))).toEqual({
      'food.format': ['food.format.kibble'],
    });
  });

  it('only FACET definitions of the document family and known options count', () => {
    const values = facetValuesBySubjectV2(
      {
        familyCode: 'toy',
        choices: [
          // FACET in food, not in toy.
          {
            code: 'food.format',
            variantId: null,
            options: ['food.format.kibble'],
          },
          {
            code: 'animal.target',
            variantId: null,
            options: ['ani.dom.dog', 'ani.dom.dragon'],
          },
          { code: 'pack.form', variantId: null, options: ['pack.form.bag'] },
        ],
      },
      vocabulary,
    );
    expect(plain(values(null))).toEqual({ 'animal.target': ['ani.dom.dog'] });
  });

  it('a document without family has no facet values', () => {
    const values = facetValuesBySubjectV2(
      {
        familyCode: null,
        choices: [
          { code: 'animal.target', variantId: null, options: ['ani.dom.dog'] },
        ],
      },
      vocabulary,
    );
    expect(values(null).size).toBe(0);
  });
});
