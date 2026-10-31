import { buildProductionVocabularyManifest } from '../../../prisma/editorial-production-vocabulary.manifest';
import { admitFreshDocumentV2 as admit } from './editorial-fresh-document-admission-v2';
import type { DocumentShapeV2 } from './editorial-document-shape-v2';
import type { SellableFactsShapeV2 } from './editorial-sellable-facts-shape-v2';
import type { CareReviewCaptureV2 } from './editorial-care-capture-shape-v2';
import * as references from './editorial-document-references-v2';
import { validateFullProductionVocabularyV2 } from './editorial-vocabulary-full-production-v2';

const evidence = { sourceRef: 'Label', verifiedOn: '2024-02-29' };
const scope = { variantIds: ['a', 'inactive'], assetIds: ['asset'] };
function vocabulary() {
  const manifest = buildProductionVocabularyManifest();
  const definitions = manifest.definitions.map((d, i) => ({
    ...d,
    id: `db/${i}`,
  }));
  return validateFullProductionVocabularyV2({
    semanticsVersion: manifest.semanticsVersion,
    definitions,
    families: manifest.families.map((f) => ({
      id: `family/${f.code}`,
      code: f.code,
      label: f.label,
      bindings: f.bindings.map((b) => ({
        ...b,
        definitionId: definitions.find((d) => d.code === b.definitionCode)!.id,
      })),
    })),
  });
}
function document(familyCode: string | null = 'hygiene'): DocumentShapeV2 {
  return {
    schemaVersion: 2,
    commercialTitle: 'Title',
    description: null,
    mediaRefs: [],
    familyCode,
    values: [],
    facts: [],
  };
}
function row(variantId: string | null = 'a'): SellableFactsShapeV2 {
  return {
    variantId,
    presentation: 'Presentation',
    declarations: [],
    careReview: null,
  };
}
function review(): Extract<CareReviewCaptureV2, { state: 'prepared' }> {
  return {
    state: 'prepared',
    jurisdiction: 'MX',
    intendedUse: 'Use',
    determination: 'identified',
    basis: 'Basis',
    evidence: [],
    requirements: [
      {
        key: 'r',
        description: 'Requirement',
        disposition: 'unresolved',
        evidence: [],
        basis: 'Basis',
      },
    ],
    warnings: [
      {
        key: 'w',
        requirementKeys: ['r'],
        text: 'Warning',
        disclosure: 'public_required',
        evidence: [],
        handlingBasis: 'Basis',
      },
    ],
  };
}
function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}
function reject(d: DocumentShapeV2, v = vocabulary()) {
  const before = JSON.stringify([d, v, scope]);
  freeze([d, v, scope]);
  expect(() => admit(d, scope, v, 'save')).toThrow(new Error('MALFORMED'));
  expect(JSON.stringify([d, v, scope])).toBe(before);
}
afterEach(() => jest.restoreAllMocks());

it('accepts an empty null family and returns no invented facts', () => {
  expect([...admit(document(null), scope, vocabulary(), 'save')]).toEqual([]);
});
it.each(['values', 'facts'] as const)('rejects null-family %s', (field) => {
  const d = document(null);
  if (field === 'facts') d.facts = [row()];
  else
    d.values = [
      {
        code: 'animal.target',
        owner: 'sellable',
        variantId: 'a',
        state: 'unknown',
        evidence: null,
      },
    ];
  reject(d);
});
it.each([
  'duplicate facts',
  'duplicate values',
  'foreign variant',
  'foreign media',
  'missing family',
])('rejects %s before qualification', (kind) => {
  const d = document();
  if (kind === 'duplicate facts') d.facts = [row(), row()];
  if (kind === 'duplicate values') {
    const value = {
      code: 'animal.target',
      owner: 'sellable' as const,
      variantId: 'a',
      state: 'unknown' as const,
      evidence: null,
    };
    d.values = [value, value];
  }
  if (kind === 'foreign variant') d.facts = [row('foreign')];
  if (kind === 'foreign media') d.mediaRefs = ['foreign'];
  if (kind === 'missing family') d.familyCode = 'missing';
  reject(d);
});
it('enforces fresh limits for family-null candidates too', () => {
  const d = document(null);
  d.commercialTitle = 'x'.repeat(201);
  reject(d);
});
it('checks later supplied evidence but permits absent evidence', () => {
  const d = document();
  d.values = ['a', 'inactive'].map((variantId) => ({
    code: 'animal.target',
    owner: 'sellable',
    variantId,
    state: 'known',
    payload: { type: 'multi', value: [] },
    evidence: null,
  }));
  expect(() => admit(d, scope, vocabulary(), 'save')).not.toThrow();
  const later = d.values[1];
  if (later.state !== 'known') throw new Error('fixture');
  later.evidence = { ...evidence, verifiedOn: '2024-02-30' };
  reject(d);
});
it('uses actual definition IDs and forwards numeric save/publish mode', () => {
  const d = document();
  const v = vocabulary();
  const f = v.families.find((f) => f.code === 'hygiene')!;
  const b = f.bindings.find((b) => b.definitionCode === 'measure.net_mass')!;
  const definition = v.definitions.find((x) => x.id === b.definitionId)!;
  if (definition.type !== 'number') throw new Error('fixture');
  definition.numericPolicy = { status: 'pending' };
  d.values = ['a', 'inactive'].map((variantId) => ({
    code: b.definitionCode,
    owner: b.owner,
    variantId,
    state: 'known',
    payload: { type: 'number', value: 2, unit: definition.units[0].code },
    evidence: null,
  }));
  expect(() => admit(d, scope, v, 'save')).not.toThrow();
  expect(() => admit(d, scope, v, 'publish')).toThrow('MALFORMED');
  const later = d.values[1];
  if (later.state !== 'known' || later.payload.type !== 'number')
    throw new Error('fixture');
  definition.numericPolicy = {
    status: 'resolved',
    magnitude: 'custom',
    integer: true,
    lower: 0,
    lowerInclusive: true,
    upper: 10,
    upperInclusive: true,
  };
  later.payload.value = 11;
  reject(d, v);
});
it('qualifies all subjects without applying publication consistency', () => {
  const d = document();
  d.facts = ['a', 'inactive'].map((id) => ({
    ...row(id),
    declarations: [
      {
        key: 'animalApplied',
        state: 'known',
        value: false,
        basis: 'Basis',
        evidence,
      },
      {
        key: 'optionalNonpertinenceCodes',
        state: 'known',
        value: [],
        basis: 'Basis',
        evidence,
      },
    ],
  }));
  const before = structuredClone(d);
  freeze(d);
  expect([...admit(d, scope, vocabulary(), 'save')]).toEqual(
    ['a', 'inactive'].map((id) => [
      id,
      { animalApplied: false, optionalNonpertinenceCodes: [] },
    ]),
  );
  expect(d).toEqual(before);
});
it('rejects invalid later facts evidence', () => {
  const d = document();
  d.facts = [
    row(),
    {
      ...row('inactive'),
      declarations: [
        {
          key: 'animalApplied',
          state: 'known',
          value: false,
          basis: 'Basis',
          evidence: { ...evidence, sourceRef: '' },
        },
      ],
    },
  ];
  reject(d);
});
it('retains custom family declaration restrictions', () => {
  const d = document('custom');
  const v = vocabulary();
  v.families.push({
    id: 'custom',
    code: 'custom',
    label: 'Custom',
    bindings: [],
  });
  d.facts = [
    {
      ...row(),
      declarations: [
        { key: 'animalApplied', state: 'unknown', evidence: null },
      ],
    },
  ];
  reject(d, v);
});
it.each([
  'dangling warning',
  'duplicate key',
  'bad evidence',
  'unresolved',
  'unknown',
] as const)('validates care capture: %s', (kind) => {
  const d = document('care');
  const r = review();
  if (kind === 'dangling warning') r.warnings[0].requirementKeys = ['missing'];
  if (kind === 'duplicate key') r.requirements.push({ ...r.requirements[0] });
  if (kind === 'bad evidence') r.evidence = [{ ...evidence, sourceRef: '' }];
  d.facts = [
    row(),
    {
      ...row('inactive'),
      careReview: kind === 'unknown' ? { state: 'unknown' } : r,
    },
  ];
  if (kind === 'unknown' || kind === 'unresolved')
    expect(() => admit(d, scope, vocabulary(), 'save')).not.toThrow();
  else reject(d);
});
it.each([
  'own negative',
  'sibling only',
  'unknown own',
  'positive own',
] as const)('NA uses qualified exact-subject facts: %s', (kind) => {
  const d = document();
  d.values = [
    {
      code: 'animal.target',
      owner: 'sellable',
      variantId: 'a',
      state: 'not_applicable',
      evidence: null,
    },
  ];
  d.facts = [
    {
      ...row(kind === 'sibling only' ? 'inactive' : 'a'),
      declarations:
        kind === 'unknown own'
          ? [{ key: 'animalApplied', state: 'unknown', evidence: null }]
          : [
              {
                key: 'animalApplied',
                state: 'known',
                value: kind === 'positive own',
                basis: 'Basis',
                evidence,
              },
            ],
    },
  ];
  if (kind === 'own negative')
    expect(admit(d, scope, vocabulary(), 'save').get('a')).toEqual({
      animalApplied: false,
    });
  else reject(d);
});
it('returns detached nested qualified values without publication contradiction checks', () => {
  const d = document('accessory');
  d.facts = [
    {
      ...row(),
      declarations: [
        {
          key: 'electricalApplies',
          state: 'known',
          value: false,
          basis: 'Basis',
          evidence,
        },
        {
          key: 'relevantEquipmentCodes',
          state: 'known',
          value: ['measure.equipment.power'],
          basis: 'Basis',
          evidence,
        },
        {
          key: 'relevantDimensionCodes',
          state: 'known',
          value: { codes: [], toyTypes: [] },
          basis: 'Basis',
          evidence,
        },
      ],
    },
  ];
  const before = structuredClone(d);
  freeze(d);
  const result = admit(d, scope, vocabulary(), 'save').get('a')!;
  expect(result.electricalApplies).toBe(false);
  result.relevantEquipmentCodes!.push('detached');
  result.relevantDimensionCodes!.codes.push('detached');
  expect(d).toEqual(before);
});
it('propagates helper error identity without translating it', () => {
  const error = new RangeError('dependency');
  jest
    .spyOn(references, 'assertFreshDocumentReferencesV2')
    .mockImplementation(() => {
      throw error;
    });
  expect(() => admit(document(), scope, vocabulary(), 'save')).toThrow(error);
  try {
    admit(document(), scope, vocabulary(), 'save');
  } catch (caught) {
    expect(caught).toBe(error);
  }
});
