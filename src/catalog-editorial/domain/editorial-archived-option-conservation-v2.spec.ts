import { conserveArchivedOptionsV2 as conserve } from './editorial-archived-option-conservation-v2';
import type { DocumentShapeV2 } from './editorial-document-shape-v2';
import type { ValueV2 } from './editorial-value-shape-v2';
import type { VocabularyV2 } from './editorial-vocabulary-shape-v2';
import * as baselines from './editorial-conservation-baseline-v2';
import { admitFreshDocumentV2 } from './editorial-fresh-document-admission-v2';

const refs = { variantIds: ['a', 'b'], assetIds: [] };
const vocabulary: VocabularyV2 = {
  semanticsVersion: 'editorial-production-1',
  definitions: ['single', 'multi'].map((type) => ({
    id: `id/${type}`,
    code: type,
    label: type,
    type: type as 'single' | 'multi',
    options: ['old', 'older', 'active'].map((code, sortOrder) => ({
      code,
      label: code,
      sortOrder,
      archived: code !== 'active',
    })),
    groups: [],
    aliases: [],
  })),
  families: ['f', 'g'].map((code) => ({
    id: `family/${code}`,
    code,
    label: code,
    bindings: ['single', 'multi'].map((definitionCode) => ({
      definitionId: `id/${definitionCode}`,
      definitionCode,
      owner: 'sellable',
      sortOrder: 0,
      exposure: 'INTERNAL',
      searchable: false,
      publicationCheck: 'when_asserted',
      policy: { route: 'pending' },
    })),
  })),
};
vocabulary.definitions.push({
  id: 'id/text',
  code: 'text',
  label: 'Text',
  type: 'text',
});
for (const family of vocabulary.families) {
  family.bindings.push({
    ...family.bindings[0],
    definitionId: 'id/text',
    definitionCode: 'text',
  });
}
function value(selection: string | string[] = 'old', variantId = 'a'): ValueV2 {
  return {
    code: Array.isArray(selection) ? 'multi' : 'single',
    owner: 'sellable',
    variantId,
    state: 'known',
    evidence: null,
    payload: Array.isArray(selection)
      ? { type: 'multi', value: selection }
      : { type: 'single', value: selection },
  };
}
function document(values = [value()]): DocumentShapeV2 {
  return {
    schemaVersion: 2,
    commercialTitle: null,
    description: null,
    mediaRefs: [],
    familyCode: 'f',
    values,
    facts: [],
  };
}
function warning(optionCode = 'old', code = 'single', variantId = 'a') {
  return {
    code: 'ARCHIVED_OPTION',
    familyId: 'family/f',
    definitionId: `id/${code}`,
    owner: 'sellable',
    variantId,
    optionCode,
  };
}
function freeze(input: unknown): void {
  if (input && typeof input === 'object') {
    Object.values(input).forEach(freeze);
    Object.freeze(input);
  }
}
function run(candidate: DocumentShapeV2, baseline: unknown) {
  const before = structuredClone([candidate, baseline, refs, vocabulary]);
  freeze([candidate, baseline, refs, vocabulary]);
  try {
    return conserve(candidate, baseline, refs, vocabulary);
  } finally {
    expect([candidate, baseline, refs, vocabulary]).toEqual(before);
  }
}
function rejects(candidate: DocumentShapeV2, baseline: unknown) {
  let error: unknown;
  try {
    run(candidate, baseline);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
  expect((error as Error).message).toBe('MALFORMED');
}
afterEach(() => jest.restoreAllMocks());

it('retains single and multi options with exact actual-ID warnings in candidate order', () => {
  const baseline = document([value(['old', 'older']), value('old', 'b')]);
  const candidate = document([value('old', 'b'), value(['older', 'old'])]);
  const result = run(candidate, baseline);
  expect(result).toEqual([
    warning('old', 'single', 'b'),
    warning('older', 'multi'),
    warning('old', 'multi'),
  ]);
  result[0].optionCode = 'detached';
  expect(run(candidate, baseline)[0]).toEqual(warning('old', 'single', 'b'));
});
it.each([['older', 'old'], ['old'], ['active', 'old'], ['active'], []])(
  'allows multi reorder/subset/removal/active addition: %j',
  (...selection) => {
    const baseline = document([value(['old', 'older'])]);
    expect(run(document([value(selection)]), baseline)).toEqual(
      selection
        .filter((code) => code !== 'active')
        .map((code) => warning(code, 'multi')),
    );
  },
);
it.each(['omitted', 'unknown', 'NA', 'active single', 'non-choice'] as const)(
  'introduces no archived options for %s',
  (kind) => {
    const candidate = document([]);
    if (kind === 'active single') candidate.values = [value('active')];
    if (kind === 'unknown' || kind === 'NA')
      candidate.values = [
        {
          code: 'single',
          owner: 'sellable',
          variantId: 'a',
          state: kind === 'NA' ? 'not_applicable' : 'unknown',
          evidence: null,
        },
      ];
    if (kind === 'non-choice')
      candidate.values = [
        {
          ...value(),
          code: 'text',
          state: 'known',
          payload: { type: 'text', value: 'ignored by choice traversal' },
        },
      ];
    expect(run(candidate, document())).toEqual([]);
  },
);
it.each([
  null,
  undefined,
  {},
  { ...document(), schemaVersion: 1 },
  document([]),
])('rejects archived assignment without baseline %j', (baseline) => {
  rejects(document(), baseline);
});
it.each(['unknown', 'not_applicable'] as const)(
  'cannot borrow a baseline %s assignment',
  (state) => {
    rejects(
      document(),
      document([
        {
          code: 'single',
          owner: 'sellable',
          variantId: 'a',
          state,
          evidence: null,
        },
      ]),
    );
  },
);
it.each([
  'family',
  'definition',
  'variant',
  'owner',
  'type',
  'single option',
  'new multi',
  're-add',
] as const)('rejects archived change: %s', (kind) => {
  const candidate = document();
  const baseline = document();
  if (kind === 'family') candidate.familyCode = 'g';
  if (kind === 'definition') candidate.values = [value(['old'])];
  if (kind === 'variant') candidate.values[0].variantId = 'b';
  if (kind === 'owner') baseline.values[0].owner = 'product';
  if (kind === 'type' && baseline.values[0].state === 'known')
    baseline.values[0].payload = { type: 'multi', value: ['old'] };
  if (kind === 'single option') baseline.values = [value('older')];
  if (kind === 'new multi') {
    candidate.values = [value(['old', 'older'])];
    baseline.values = [value(['old'])];
  }
  if (kind === 're-add') {
    candidate.values = [value(['old'])];
    baseline.values = [value(['active'])];
  }
  rejects(candidate, baseline);
});
it('a later unrelated invalid baseline row removes all grants, but active correction still works', () => {
  const baseline = document([value(), value('active', 'foreign')]);
  rejects(document(), baseline);
  expect(run(document([value('active')]), baseline)).toEqual([]);
});
it('conserves recognizable bad historical evidence without waiving fresh admission', () => {
  const baseline = document();
  const first = baseline.values[0];
  if (first.state !== 'known') throw new Error('fixture');
  first.evidence = { sourceRef: '', verifiedOn: 'invalid' };
  expect(run(document(), baseline)).toEqual([warning()]);
  expect(() =>
    admitFreshDocumentV2(baseline, refs, vocabulary, 'save'),
  ).toThrow('MALFORMED');
});
it('does not treat a missing current option as active', () => {
  const current = structuredClone(vocabulary);
  for (const definition of current.definitions) {
    if (definition.type === 'single') definition.options = [];
  }
  expect(() => conserve(document(), document(), refs, current)).toThrow(
    'MALFORMED',
  );
});
it('propagates unexpected whole-baseline qualification failures unchanged', () => {
  const error = new RangeError('baseline');
  jest
    .spyOn(baselines, 'eligibleConservationBaselineV2')
    .mockImplementation(() => {
      throw error;
    });
  let caught: unknown;
  try {
    run(document(), document());
  } catch (failure) {
    caught = failure;
  }
  expect(caught).toBe(error);
});
