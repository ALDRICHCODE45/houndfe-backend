import { emptyDocument, validateDocument } from './document';
import type { DocumentAuthority } from './document';

const authority: DocumentAuthority = {
  tenantId: 't',
  productId: 'p',
  variantIds: ['v'],
  assetIds: ['private-a'],
  families: [
    {
      code: 'food',
      attributes: [
        { code: 'label', owner: 'product', type: 'text' },
        { code: 'organic', owner: 'product', type: 'boolean' },
        { code: 'volume', owner: 'sellable', type: 'number', units: ['ml'] },
        { code: 'color', owner: 'sellable', type: 'single', codes: ['red'] },
        { code: 'tags', owner: 'product', type: 'multi', codes: ['a', 'b'] },
      ],
    },
  ],
};
const valid = () => ({
  ...emptyDocument(),
  familyCode: 'food',
  mediaRefs: ['private-a'],
  values: [
    {
      code: 'label',
      owner: 'product',
      variantId: null,
      type: 'text',
      value: '',
    },
    {
      code: 'organic',
      owner: 'product',
      variantId: null,
      type: 'boolean',
      value: false,
    },
    {
      code: 'volume',
      owner: 'sellable',
      variantId: 'v',
      type: 'number',
      value: 500,
      unit: 'ml',
    },
    {
      code: 'color',
      owner: 'sellable',
      variantId: 'v',
      type: 'single',
      value: 'red',
    },
    {
      code: 'tags',
      owner: 'product',
      variantId: null,
      type: 'multi',
      value: ['a', 'b'],
    },
  ],
});
function value(index: number, patch: Record<string, unknown>) {
  const d = valid();
  return {
    ...d,
    values: d.values.map((v, i) => (i === index ? { ...v, ...patch } : v)),
  };
}
const cases: [string, unknown][] = [
  ['unknown key', { ...valid(), price: 1 }],
  ['missing fields', {}],
  ['bad title', { ...valid(), commercialTitle: 3 }],
  ['unknown family', { ...valid(), familyCode: 'other' }],
  ['values without family', { ...valid(), familyCode: null }],
  ['foreign/public media', { ...valid(), mediaRefs: ['/uploads/a'] }],
  ['duplicate media', { ...valid(), mediaRefs: ['private-a', 'private-a'] }],
  ['sparse media', { ...valid(), mediaRefs: new Array<string>(1) }],
  ['unknown code', value(0, { code: 'unknown' })],
  ['wrong owner', value(0, { owner: 'sellable' })],
  ['unknown value key', value(0, { extra: 1 })],
  ['wrong text', value(0, { value: 1 })],
  ['wrong boolean', value(1, { value: 'false' })],
  ['wrong type', value(0, { type: 'boolean' })],
  ['wrong unit', value(2, { unit: 'kg' })],
  ['nonfinite', value(2, { value: Infinity })],
  ['foreign variant', value(2, { variantId: 'foreign' })],
  ['simple target with variants', value(2, { variantId: null })],
  ['product target variant', value(0, { variantId: 'v' })],
  ['selection label', value(3, { value: 'Red label' })],
  ['multi unknown code', value(4, { value: ['z'] })],
  ['multi duplicates', value(4, { value: ['a', 'a'] })],
  ['sparse multi selection', value(4, { value: new Array<string>(1) })],
  [
    'duplicate binding',
    { ...valid(), values: [valid().values[0], valid().values[0]] },
  ],
];

describe('closed editorial document', () => {
  it('permits incomplete documents and all five types', () => {
    expect(validateDocument(emptyDocument(), authority)).toEqual(
      emptyDocument(),
    );
    expect(validateDocument(valid(), authority)).toEqual(valid());
  });
  it.each(cases)('rejects %s', (_name, document) => {
    expect(() => validateDocument(document, authority)).toThrow('MALFORMED');
  });
  it('requires a simple sellable target only when there are no variants', () => {
    const document = value(2, { variantId: null });
    document.values = [document.values[2]];
    const simple = { ...authority, variantIds: [] };
    expect(validateDocument(document, simple)).toEqual(document);
    expect(() => validateDocument(valid(), simple)).toThrow();
  });
  it('preserves media order and detaches returned data', () => {
    const input = { ...emptyDocument(), mediaRefs: ['b', 'a'] };
    const result = validateDocument(input, {
      ...authority,
      assetIds: ['a', 'b'],
    });
    input.mediaRefs.reverse();
    expect(result.mediaRefs).toEqual(['b', 'a']);
  });
});
