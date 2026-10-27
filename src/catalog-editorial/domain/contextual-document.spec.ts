import { emptyDocument, validateDocument } from './document';
import type {
  DocumentAuthority,
  EditorialDocument,
  EditorialValue,
} from './document';
import type { EditorialDefinitionsSnapshot } from './editorial-definitions';
import { validateContextualDocument } from './contextual-document';

const references = {
  tenantId: 't',
  productId: 'p',
  variantIds: ['v', 'w'],
  assetIds: ['private'],
};
const definitions: EditorialDefinitionsSnapshot = {
  families: ['f', 'g'].map((id) => ({
    id,
    code: id,
    bindings: [
      { definitionId: 'color-id', owner: 'sellable' as const },
      { definitionId: 'tags-id', owner: 'product' as const },
    ],
  })),
  definitions: [
    {
      id: 'color-id',
      code: 'color',
      type: 'single',
      options: [
        { code: 'old', archived: true },
        { code: 'new', archived: false },
      ],
    },
    {
      id: 'tags-id',
      code: 'tags',
      type: 'multi',
      options: [
        { code: 'old', archived: true },
        { code: 'new', archived: false },
        { code: 'fresh', archived: false },
      ],
    },
  ],
};
const color: EditorialValue = {
  code: 'color',
  owner: 'sellable',
  variantId: 'v',
  type: 'single',
  value: 'old',
};
const tags: EditorialValue = {
  code: 'tags',
  owner: 'product',
  variantId: null,
  type: 'multi',
  value: ['old', 'new'],
};
const document = (values: EditorialValue[] = [color]): EditorialDocument => ({
  ...emptyDocument(),
  familyCode: 'f',
  values: JSON.parse(JSON.stringify(values)) as EditorialValue[],
});
const check = (
  input: unknown,
  baseline: EditorialDocument | null = document(),
) => validateContextualDocument(input, references, definitions, baseline);

it('retains an archived assignment only at its original binding and warns precisely', () => {
  expect(check(document())).toEqual({
    document: document(),
    warnings: [
      {
        code: 'ARCHIVED_OPTION',
        familyId: 'f',
        definitionId: 'color-id',
        owner: 'sellable',
        variantId: 'v',
        optionCode: 'old',
      },
    ],
  });
});
it.each([
  ['new assignment', document(), null],
  ['reintroduced assignment', document(), document([])],
  ['different variant', document([{ ...color, variantId: 'w' }]), document()],
  ['different family', { ...document(), familyCode: 'g' }, document()],
  ['different definition', document([tags]), document()],
  [
    'different owner',
    document([{ ...color, owner: 'product', variantId: null }]),
    document(),
  ],
] as const)(
  'rejects archived %s without mutating inputs',
  (_name, input, baseline) => {
    const before = structuredClone({ input, baseline, definitions });
    expect(() => check(input, baseline)).toThrow('MALFORMED');
    expect({ input, baseline, definitions }).toEqual(before);
  },
);
it.each([{ values: [] }, { values: [{ ...color, value: 'new' }] }])(
  'permits removal or replacement with an active option',
  ({ values }) => {
    expect(check(document(values))).toEqual({
      document: document(values),
      warnings: [],
    });
  },
);
it('uses per-option membership for multi reorder, removal and active replacement', () => {
  const baseline = document([tags]);
  for (const value of [['new', 'old'], ['old'], ['fresh', 'old']]) {
    const input = document([{ ...tags, value }]);
    expect(check(input, baseline)).toEqual({
      document: input,
      warnings: [
        {
          code: 'ARCHIVED_OPTION',
          familyId: 'f',
          definitionId: 'tags-id',
          owner: 'product',
          variantId: null,
          optionCode: 'old',
        },
      ],
    });
  }
  expect(
    check(document([{ ...tags, value: ['fresh'] }]), baseline).warnings,
  ).toEqual([]);
  expect(() =>
    check(document([tags]), document([{ ...tags, value: ['new'] }])),
  ).toThrow('MALFORMED');
});
it('does not preserve revoked media or variants through the baseline', () => {
  const input = { ...document(), mediaRefs: ['private'] };
  expect(() =>
    validateContextualDocument(
      input,
      { ...references, assetIds: [] },
      definitions,
      input,
    ),
  ).toThrow('MALFORMED');
  expect(() =>
    validateContextualDocument(
      input,
      { ...references, variantIds: ['w'] },
      definitions,
      input,
    ),
  ).toThrow('MALFORMED');
});
it('does not preserve an option missing from current definitions', () => {
  const current = structuredClone(definitions);
  current.definitions[0] = {
    id: 'color-id',
    code: 'color',
    type: 'single',
    options: [],
  };
  expect(() =>
    validateContextualDocument(document(), references, current, document()),
  ).toThrow('MALFORMED');
});
it('leaves legacy validation unchanged and matches active-option behavior', () => {
  const legacy: DocumentAuthority = {
    ...references,
    families: [
      {
        code: 'f',
        attributes: [
          { code: 'color', owner: 'sellable', type: 'single', codes: ['new'] },
        ],
      },
    ],
  };
  const input = document([{ ...color, value: 'new' }]);
  expect(check(input, null).document).toEqual(validateDocument(input, legacy));
  expect(() => validateDocument(document(), legacy)).toThrow('MALFORMED');
  expect(check(emptyDocument(), null)).toEqual({
    document: emptyDocument(),
    warnings: [],
  });
});
it('detaches returned documents and warnings from inputs', () => {
  const input = document();
  const result = check(input);
  input.values.length = 0;
  expect(result.document).toEqual(document());
  expect(result.warnings).toHaveLength(1);
});
