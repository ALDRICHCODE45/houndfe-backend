import { hashEditorialJson } from './editorial-canonical-json';
import * as canonical from './editorial-vocabulary-canonical-v2';
import { materializeHistoricalVocabularyResponseV2 as materialize } from './editorial-vocabulary-historical-v2';
import type { BindingPolicy } from './editorial-vocabulary-policy-shape-v2';
import * as stored from './editorial-vocabulary-stored-root-v2';

const pending = { status: 'pending' as const };
const resolved = {
  status: 'resolved' as const,
  magnitude: ' custom magnitude ',
  integer: false,
  lower: null,
  lowerInclusive: false,
  upper: null,
  upperInclusive: false,
};
const optionCases: BindingPolicy = {
  route: 'option_cases',
  cases: [
    {
      code: ' custom case ',
      when: [],
      applicability: 'applicable',
      required: false,
      allowNA: true,
      evidenceRequired: false,
      documentary: 'unresolved',
    },
  ],
};
const factRule: BindingPolicy = {
  route: 'fact_rule',
  rule: { family: 'food', ruleId: 'required', parameter: 'animal.target' },
};
const definition = (id = 'd', type = 'number') => ({
  id,
  code: `custom.${id}`,
  label: ` Label ${id} ñ `,
  type,
  numericPolicy: pending as typeof pending | typeof resolved,
  units: [],
  options: [],
  groups: [],
  aliases: [],
});
const family = (id = 'f', definitionId = 'd', version = 1) => ({
  id,
  code: `custom.${id}`,
  label: ` Family ${id} `,
  minimumContractVersion: version,
  bindings: [
    {
      familyId: id,
      definitionId,
      definitionCode: `custom.${definitionId}`,
      owner: 'sellable',
      sortOrder: -3,
      exposure: 'DETAIL',
      searchable: false,
      publicationCheck: 'when_asserted',
      policy: { route: 'pending' } as BindingPolicy,
    },
  ],
});
const fixture = () => ({
  metadata: { id: 'global', semanticsVersion: 'editorial-production-1' },
  families: [family()],
  definitions: [definition()],
});
function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}
const advanced = [
  [
    'range',
    (row: ReturnType<typeof fixture>) => {
      row.definitions[0].type = 'range';
    },
  ],
  [
    'resolved number',
    (row: ReturnType<typeof fixture>) => {
      row.definitions[0].numericPolicy = resolved;
    },
  ],
  [
    'option_cases',
    (row: ReturnType<typeof fixture>) => {
      row.families[0].bindings[0].policy = optionCases;
    },
  ],
  [
    'fact_rule',
    (row: ReturnType<typeof fixture>) => {
      row.families[0].bindings[0].policy = factRule;
    },
  ],
] as const;

describe('dormant historical V2 response', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each(advanced)(
    'preserves generic-valid %s regardless of stored legacy column',
    (_, change) => {
      const input = fixture();
      change(input);
      input.families.unshift(family('valid', 'sibling', 2));
      input.definitions.push(definition('sibling'));
      const before = structuredClone(input);
      freeze(input);
      const result = materialize(input);
      expect(result.vocabulary).toEqual(
        canonical.canonicalizeVocabularyV2(
          stored.materializeStoredVocabularyV2(input),
        ),
      );
      expect(
        result.vocabulary.families.every(
          (f) => !('minimumContractVersion' in f),
        ),
      ).toBe(true);
      expect(input).toEqual(before);
    },
  );

  it.each(advanced)('preserves generic-valid declared V2 %s', (_, change) => {
    const input = fixture();
    change(input);
    input.families[0].minimumContractVersion = 2;
    const before = structuredClone(input);
    freeze(input);
    const result = materialize(input);
    expect(result.vocabulary).toEqual(
      stored.materializeStoredVocabularyV2(input),
    );
    expect(input).toEqual(before);
    expect(result.vocabulary.families[0]).not.toBe(input.families[0]);
    expect(result.vocabulary.definitions[0]).not.toBe(input.definitions[0]);
  });

  it('preserves shared resolved definitions without storage-version classification', () => {
    const input = fixture();
    input.definitions[0].numericPolicy = resolved;
    input.families.unshift(family('advanced', 'd', 2));
    expect(materialize(input).vocabulary.definitions).toHaveLength(1);
  });

  it('allows originally unbound advanced definitions beside pending legacy metadata', () => {
    const input = fixture();
    input.definitions.push({
      ...definition('unbound', 'range'),
      numericPolicy: resolved,
    });
    expect(materialize(input).vocabulary.definitions).toHaveLength(2);
    expect(materialize(input).vocabulary.families[0]).not.toHaveProperty(
      'minimumContractVersion',
    );
  });

  it('allows empty vocabulary and empty custom families without production admission', () => {
    const input = fixture();
    input.definitions = [];
    input.families[0].bindings = [];
    expect(materialize(input).vocabulary.families).toHaveLength(1);
    input.families = [];
    expect(materialize(input).vocabulary).toEqual({
      semanticsVersion: 'editorial-production-1',
      families: [],
      definitions: [],
    });
  });

  it.each(['shape', 'reference'])(
    'rejects generic %s before canonical construction',
    (kind) => {
      const input = fixture();
      if (kind === 'shape') input.definitions[0].type = 'unsupported';
      else input.families[0].bindings[0].definitionId = 'missing';
      const builder = jest.spyOn(canonical, 'createVocabularyResponseV2');
      freeze(input);
      expect(() => materialize(input)).toThrow(TypeError);
      expect(builder).not.toHaveBeenCalled();
    },
  );

  it('uses actual IDs for every family and passes only validated data to the builder', () => {
    const input = fixture();
    input.families.push(family('second', 'd', 2));
    const root = jest.spyOn(stored, 'materializeStoredVocabularyV2');
    const builder = jest.spyOn(canonical, 'createVocabularyResponseV2');
    const result = materialize(input);
    const validated = root.mock.results[0].value as ReturnType<
      typeof stored.materializeStoredVocabularyV2
    >;
    expect(validated.families.map((f) => f.bindings[0].definitionId)).toEqual([
      'd',
      'd',
    ]);
    expect(builder).toHaveBeenCalledWith(validated);
    expect(result).toBe(builder.mock.results[0].value);
  });

  it('returns the independently assembled canonical envelope/preimage without sorting stored input', () => {
    const input = fixture();
    input.families = [family('z', 'z'), family('a', 'a')];
    input.definitions = [definition('z'), definition('a')];
    const before = structuredClone(input);
    freeze(input);
    const vocabulary = {
      semanticsVersion: 'editorial-production-1',
      families: ['a', 'z'].map((id) => ({
        id,
        code: `custom.${id}`,
        label: ` Family ${id} `,
        bindings: [
          {
            definitionId: id,
            definitionCode: `custom.${id}`,
            owner: 'sellable',
            sortOrder: -3,
            exposure: 'DETAIL',
            searchable: false,
            publicationCheck: 'when_asserted',
            policy: { route: 'pending' },
          },
        ],
      })),
      definitions: ['a', 'z'].map((id) => ({
        id,
        code: `custom.${id}`,
        label: ` Label ${id} ñ `,
        type: 'number',
        numericPolicy: { status: 'pending' },
        units: [],
      })),
    };
    const result = materialize(input);
    expect(result).toEqual({
      contractVersion: 2,
      vocabularyRevision: `ev2-sha256-${hashEditorialJson({ contractVersion: 2, vocabulary })}`,
      vocabulary,
    });
    result.vocabulary.families[0].bindings[0].sortOrder = 99;
    result.vocabulary.definitions[0].label = 'changed';
    expect(input).toEqual(before);
  });

  it.each(['stored', 'canonical'] as const)(
    'propagates %s sentinel errors by identity',
    (seam) => {
      const sentinel = new Error('Unicode/runtime/dependency sentinel');
      const fail = () => {
        throw sentinel;
      };
      if (seam === 'stored')
        jest
          .spyOn(stored, 'materializeStoredVocabularyV2')
          .mockImplementation(fail);
      if (seam === 'canonical')
        jest
          .spyOn(canonical, 'createVocabularyResponseV2')
          .mockImplementation(fail);
      let caught: unknown;
      try {
        materialize(fixture());
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(sentinel);
    },
  );
});
