import type { DocumentAuthority } from './document';
import { assertFreshDocumentReferencesV2 as assertReferences } from './editorial-document-references-v2';
import type { DocumentShapeV2 } from './editorial-document-shape-v2';
import type { KnownPayloadV2 } from './editorial-known-payload-shape-v2';
import type { ValueV2 } from './editorial-value-shape-v2';
import { validateVocabularyConsistencyV2 } from './editorial-vocabulary-consistency-v2';
import type { VocabularyV2 } from './editorial-vocabulary-shape-v2';

const definitions: VocabularyV2['definitions'] = [
  { id: 'db-text-91', code: 'custom.text', label: 'Text', type: 'text' },
  { id: 'db-bool-32', code: 'custom.boolean', label: 'Flag', type: 'boolean' },
  ...(['number', 'range'] as const).map((type) => ({
    id: `db-${type}-78`,
    code: `custom.${type}`,
    label: type,
    type,
    units: [
      { code: 'cm', label: 'Centimetres', sortOrder: 0 },
      ...(type === 'number' ? [{ code: null, label: null, sortOrder: 1 }] : []),
    ],
    numericPolicy: { status: 'pending' as const },
  })),
  ...(['single', 'multi'] as const).map((type) => ({
    id: `db-${type}-54`,
    code: `custom.${type}`,
    label: type,
    type,
    options: [
      { code: 'Exact', label: 'Display', archived: false, sortOrder: 0 },
      { code: 'retired', label: 'Retired', archived: true, sortOrder: 1 },
    ],
    groups: [{ code: 'bundle', label: 'Bundle', optionCodes: ['Exact'] }],
    aliases: [{ label: 'Alias', optionCode: 'Exact' }],
  })),
];
const vocabulary = validateVocabularyConsistencyV2({
  semanticsVersion: 'editorial-production-1',
  definitions,
  families: [
    {
      id: 'db-family-56',
      code: 'custom.family',
      label: 'Custom',
      bindings: definitions.map((definition) => ({
        definitionId: definition.id,
        definitionCode: definition.code,
        owner: definition.type === 'text' ? 'product' : 'sellable',
        sortOrder: 0,
        exposure: 'INTERNAL',
        searchable: false,
        publicationCheck: 'when_asserted',
        policy: { route: 'pending' },
      })),
    },
  ],
});
const simple: Pick<DocumentAuthority, 'variantIds' | 'assetIds'> = {
  variantIds: [],
  assetIds: ['asset-local'],
};
// Includes inactive variants: this is all real subjects, not publication E.
const variants = { ...simple, variantIds: ['active', 'inactive'] };
const payloads: KnownPayloadV2[] = [
  { type: 'text', value: '' },
  { type: 'boolean', value: false },
  { type: 'number', value: -0.5, unit: null },
  { type: 'range', min: 4, max: -2, unit: 'cm' },
  { type: 'single', value: 'Exact' },
  { type: 'multi', value: ['Exact', 'retired'] },
];
function value(payload: KnownPayloadV2 = payloads[1]): ValueV2 {
  return {
    code: `custom.${payload.type}`,
    owner: payload.type === 'text' ? 'product' : 'sellable',
    variantId: null,
    state: 'known',
    payload,
    evidence: null,
  };
}
function document(values: ValueV2[] = []): DocumentShapeV2 {
  return {
    schemaVersion: 2,
    commercialTitle: null,
    description: null,
    mediaRefs: [],
    familyCode: 'custom.family',
    values,
    facts: [],
  };
}
function fact(variantId: string | null) {
  return { variantId, presentation: '', declarations: [], careReview: null };
}
function reject(
  candidate: DocumentShapeV2,
  references = simple,
  metadata = vocabulary,
) {
  expect(() => assertReferences(candidate, references, metadata)).toThrow(
    new Error('MALFORMED'),
  );
}

describe('fresh V2 references only (T3d S2)', () => {
  it('accepts empty/incomplete candidates without all-binding or fact requirements', () => {
    assertReferences(document(), simple, vocabulary);
    assertReferences({ ...document(), familyCode: null }, variants, vocabulary);
  });
  it.each(payloads)(
    'accepts exact known $type membership without numeric/domain checks',
    (payload) => {
      assertReferences(document([value(payload)]), simple, vocabulary);
    },
  );
  it('uses actual custom IDs, allows product ownership on variant products and inactive subjects', () => {
    const candidate = document([
      value(payloads[0]),
      { ...value(), variantId: 'inactive' },
    ]);
    candidate.facts = [fact('active'), fact('inactive')];
    assertReferences(candidate, variants, vocabulary);
  });
  it.each(['known', 'unknown', 'not_applicable'] as const)(
    'resolves binding/owner/subject for %s',
    (state) => {
      const row: ValueV2 =
        state === 'known'
          ? value()
          : {
              code: 'custom.boolean',
              owner: 'sellable',
              variantId: null,
              state,
              evidence: null,
            };
      assertReferences(document([row]), simple, vocabulary);
      assertReferences(
        document([{ ...row, variantId: 'inactive' }]),
        variants,
        vocabulary,
      );
      for (const code of ['custom.absent', 'deleted'])
        reject(document([{ ...row, code }]));
      reject(document([{ ...row, owner: 'product' }]));
      reject(document([row]), variants);
      reject(document([{ ...row, variantId: 'deleted' }]), variants);
      reject(document([{ ...row, variantId: 'active' }]), simple);
    },
  );
  it.each(['known', 'unknown', 'not_applicable'] as const)(
    'requires null product subject for %s',
    (state) => {
      const row: ValueV2 =
        state === 'known'
          ? value(payloads[0])
          : {
              code: 'custom.text',
              owner: 'product',
              variantId: null,
              state,
              evidence: null,
            };
      assertReferences(document([row]), variants, vocabulary);
      reject(document([{ ...row, variantId: 'active' }]), variants);
    },
  );
  it('rejects unbound definitions even when they exist globally', () => {
    const metadata = {
      ...vocabulary,
      families: [{ ...vocabulary.families[0], bindings: [] }],
    };
    reject(document([value()]), simple, metadata);
  });
  it('rejects an unknown selected family and null-family values or facts', () => {
    reject({ ...document(), familyCode: 'deleted' });
    reject({ ...document([value()]), familyCode: null });
    reject({ ...document(), familyCode: null, facts: [fact(null)] });
  });
  it('rejects duplicate composite keys independently with a valid same owner', () => {
    const row = value();
    reject(document([row, row]));
    reject(
      document([
        { ...row, variantId: 'inactive' },
        { ...row, variantId: 'inactive' },
      ]),
      variants,
    );
    assertReferences(
      document([
        { ...row, variantId: 'active' },
        { ...row, variantId: 'inactive' },
      ]),
      variants,
      vocabulary,
    );
  });
  it('rejects an owner-changing duplicate (also independently an owner mismatch)', () => {
    reject(document([value(), { ...value(), owner: 'product' }]));
  });
  it.each(payloads)(
    'rejects payload type disagreement for $type',
    (payload) => {
      reject(
        document([
          {
            ...value(payload),
            code: payload.type === 'text' ? 'custom.boolean' : 'custom.text',
            owner: payload.type === 'text' ? 'sellable' : 'product',
          },
        ]),
      );
    },
  );
  it('requires exact actual number units, including explicit null membership', () => {
    assertReferences(
      document([value({ type: 'number', value: 2, unit: 'cm' })]),
      simple,
      vocabulary,
    );
    for (const unit of ['CM', 'mm', 'Centimetres'])
      reject(document([value({ type: 'number', value: 2, unit })]));
    const metadata = {
      ...vocabulary,
      definitions: vocabulary.definitions.map((definition) =>
        definition.type === 'number'
          ? {
              ...definition,
              units: definition.units.filter((unit) => unit.code !== null),
            }
          : definition,
      ),
    };
    reject(
      document([value({ type: 'number', value: 2, unit: null })]),
      simple,
      metadata,
    );
  });
  it.each(['CM', 'mm', 'Centimetres'])(
    'rejects nonmember range unit %s',
    (unit) => {
      reject(document([value({ type: 'range', min: 1, max: 2, unit })]));
    },
  );
  it.each(['Alias', 'Display', 'bundle', 'exact', 'EXACT', 'deleted'])(
    'rejects non-option %s for single and multi',
    (code) => {
      reject(document([value({ type: 'single', value: code })]));
      reject(document([value({ type: 'multi', value: [code] })]));
    },
  );
  it('rejects duplicate multi options and accepts an empty multi assertion', () => {
    reject(document([value({ type: 'multi', value: ['Exact', 'Exact'] })]));
    assertReferences(
      document([value({ type: 'multi', value: [] })]),
      simple,
      vocabulary,
    );
  });
  it('accepts archived options as REFERENCE ONLY, not assignment entitlement', () => {
    for (const payload of [
      { type: 'single', value: 'retired' },
      { type: 'multi', value: ['retired'] },
    ] as const) {
      // Mutable payload arrays are the wire type; this is not a conservation test.
      const candidate =
        payload.type === 'single'
          ? value(payload)
          : value({ type: 'multi', value: [...payload.value] });
      assertReferences(document([candidate]), simple, vocabulary);
    }
  });
  it('checks media uniqueness and selected-asset membership', () => {
    assertReferences(
      { ...document(), mediaRefs: ['asset-local'] },
      simple,
      vocabulary,
    );
    reject({ ...document(), mediaRefs: ['asset-local', 'asset-local'] });
    reject({ ...document(), mediaRefs: ['foreign'] });
  });
  it('checks all facts for duplicate and real subjects, not E/completeness', () => {
    assertReferences(
      { ...document(), facts: [fact(null)] },
      simple,
      vocabulary,
    );
    reject({ ...document(), facts: [fact(null), fact(null)] });
    reject({ ...document(), facts: [fact('active')] });
    reject({ ...document(), facts: [fact(null)] }, variants);
    reject({ ...document(), facts: [fact('deleted')] }, variants);
    reject(
      { ...document(), facts: [fact('inactive'), fact('inactive')] },
      variants,
    );
  });
  it('preserves recursively frozen inputs on success and failure', () => {
    function freeze(input: unknown): void {
      if (!input || typeof input !== 'object') return;
      for (const child of Object.values(input)) freeze(child);
      Object.freeze(input);
    }
    const candidate = document(payloads.map((payload) => value(payload)));
    const invalid = { ...document(), mediaRefs: ['foreign'] };
    const before = JSON.stringify([candidate, invalid, simple, vocabulary]);
    for (const input of [candidate, invalid, simple, vocabulary]) freeze(input);
    assertReferences(candidate, simple, vocabulary);
    reject(invalid);
    expect(JSON.stringify([candidate, invalid, simple, vocabulary])).toBe(
      before,
    );
  });
});
