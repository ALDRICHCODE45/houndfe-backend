import { eligibleConservationBaselineV2 as eligible } from './editorial-conservation-baseline-v2';
import { admitFreshDocumentV2 } from './editorial-fresh-document-admission-v2';
import type { DocumentShapeV2 } from './editorial-document-shape-v2';
import type { VocabularyV2 } from './editorial-vocabulary-shape-v2';
import * as references from './editorial-document-references-v2';

const scope = { variantIds: ['a', 'b'], assetIds: ['asset'] };
function vocabulary(): VocabularyV2 {
  return {
    semanticsVersion: 'editorial-production-1',
    definitions: [
      {
        id: 'choice-id',
        code: 'choice',
        label: 'Choice',
        type: 'multi',
        options: [{ code: 'old', label: 'Old', archived: true, sortOrder: 0 }],
        groups: [],
        aliases: [],
      },
      {
        id: 'number-id',
        code: 'number',
        label: 'Number',
        type: 'number',
        units: [{ code: 'cm', label: 'cm', sortOrder: 0 }],
        numericPolicy: {
          status: 'resolved',
          magnitude: 'custom',
          integer: true,
          lower: 0,
          lowerInclusive: true,
          upper: 10,
          upperInclusive: true,
        },
      },
    ],
    families: [
      {
        id: 'family-id',
        code: 'custom',
        label: 'Custom',
        bindings: ['choice', 'number'].map((code) => ({
          definitionId: `${code}-id`,
          definitionCode: code,
          owner: 'sellable',
          sortOrder: 0,
          exposure: 'INTERNAL',
          searchable: false,
          publicationCheck: 'when_asserted',
          policy: { route: 'pending' },
        })),
      },
    ],
  };
}
function document(): DocumentShapeV2 {
  return {
    schemaVersion: 2,
    commercialTitle: null,
    description: null,
    mediaRefs: ['asset'],
    familyCode: 'custom',
    values: [
      {
        code: 'choice',
        owner: 'sellable',
        variantId: 'a',
        state: 'known',
        payload: { type: 'multi', value: ['old'] },
        evidence: null,
      },
    ],
    facts: [],
  };
}
function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}
function check(d: unknown, accepted: boolean, v = vocabulary()) {
  const before = structuredClone([d, scope, v]);
  freeze([d, scope, v]);
  const result = eligible(d, scope, v);
  expect(result).toEqual(accepted ? d : null);
  expect([d, scope, v]).toEqual(before);
  return result;
}
afterEach(() => jest.restoreAllMocks());

it('retains an archived assignment as a detached whole baseline', () => {
  const d = document();
  const result = check(d, true)!;
  expect(result).not.toBe(d);
  result.mediaRefs.push('detached');
  const value = result.values[0];
  if (value.state !== 'known' || value.payload.type !== 'multi')
    throw new Error('fixture');
  value.payload.value.push('detached');
  expect(d.mediaRefs).toEqual(['asset']);
  expect(d.values[0]).toMatchObject({ payload: { value: ['old'] } });
});
it.each([
  null,
  {},
  { ...document(), schemaVersion: 1 },
  { ...document(), schemaVersion: 3 },
  { ...document(), extra: true },
])('grants no baseline for malformed/legacy/future %j', (input) => {
  check(input, false);
});
it('rejects a static invalid axis even when document references pass', () => {
  const d = document();
  d.facts = [
    {
      variantId: 'a',
      presentation: '',
      careReview: null,
      declarations: [
        {
          key: 'relevantFitCodes',
          state: 'known',
          value: ['not-an-axis'],
          evidence: { sourceRef: '', verifiedOn: '' },
          basis: '',
        },
      ],
    },
  ];
  check(d, false);
});
it.each([
  'foreign variant',
  'missing binding',
  'missing option',
  'wrong owner',
  'duplicate value',
  'wrong unit',
  'revoked media',
  'duplicate facts',
  'foreign facts',
  'missing family',
  'missing definition',
])('invalidates the entire baseline for %s', (kind) => {
  const d = document();
  const v = vocabulary();
  const later = { ...d.values[0], variantId: 'b' };
  d.values.push(later);
  if (kind === 'foreign variant') later.variantId = 'foreign';
  if (kind === 'missing binding') later.code = 'missing';
  if (kind === 'missing option' && later.state === 'known')
    later.payload = { type: 'multi', value: ['missing'] };
  if (kind === 'wrong owner') later.owner = 'product';
  if (kind === 'duplicate value') later.variantId = 'a';
  if (kind === 'wrong unit' && later.state === 'known') {
    later.code = 'number';
    later.payload = { type: 'number', value: 1, unit: 'foreign' };
  }
  if (kind === 'revoked media') d.mediaRefs.push('revoked');
  if (kind === 'duplicate facts' || kind === 'foreign facts')
    d.facts = ['a', kind === 'duplicate facts' ? 'a' : 'foreign'].map(
      (variantId) => ({
        variantId,
        presentation: '',
        declarations: [],
        careReview: null,
      }),
    );
  if (kind === 'missing family') v.families = [];
  if (kind === 'missing definition') v.definitions = [];
  check(d, false, v);
});
it.each([
  'bad evidence',
  'numeric policy',
  'oversized text',
  'facts qualification',
  'care capture',
] as const)('retains structural history despite fresh %s failure', (kind) => {
  const d = document();
  if (kind === 'bad evidence' && d.values[0].state === 'known')
    d.values[0].evidence = { sourceRef: '\ud800', verifiedOn: 'not-a-date' };
  if (kind === 'numeric policy')
    d.values.push({
      code: 'number',
      owner: 'sellable',
      variantId: 'b',
      state: 'known',
      payload: { type: 'number', value: -1, unit: 'cm' },
      evidence: null,
    });
  if (kind === 'oversized text') d.commercialTitle = 'x'.repeat(201);
  if (kind === 'facts qualification' || kind === 'care capture')
    d.facts = [
      {
        variantId: 'a',
        presentation: '',
        declarations: [
          { key: 'animalApplied', state: 'unknown', evidence: null },
        ],
        careReview:
          kind === 'care capture'
            ? {
                state: 'prepared',
                jurisdiction: '',
                intendedUse: '',
                determination: 'identified',
                evidence: [],
                basis: '',
                requirements: [],
                warnings: [],
              }
            : null,
      },
    ];
  check(d, true);
  expect(() => admitFreshDocumentV2(d, scope, vocabulary(), 'save')).toThrow(
    'MALFORMED',
  );
});
it('does not turn a null-family empty document into an absent baseline', () => {
  const d = { ...document(), familyCode: null, values: [], facts: [] };
  check(d, true);
});
it('recognition reflection failures propagate even when named MALFORMED', () => {
  const error = new Error('MALFORMED');
  const input = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw error;
      },
    },
  );
  expect(() => eligible(input, scope, vocabulary())).toThrow(error);
});
it.each([new RangeError('MALFORMED'), new Error('unexpected')])(
  'does not swallow unexpected reference failures: %j',
  (error) => {
    jest
      .spyOn(references, 'assertFreshDocumentReferencesV2')
      .mockImplementation(() => {
        throw error;
      });
    let caught: unknown;
    try {
      eligible(document(), scope, vocabulary());
    } catch (failure) {
      caught = failure;
    }
    expect(caught).toBe(error);
  },
);
