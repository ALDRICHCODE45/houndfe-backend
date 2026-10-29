import { createHash } from 'node:crypto';
import {
  canonicalizeVocabularyV2 as canonicalize,
  createVocabularyResponseV2 as respond,
} from './editorial-vocabulary-canonical-v2';
import * as consistency from './editorial-vocabulary-consistency-v2';
import * as json from './editorial-canonical-json';
import type { BindingV2 } from './editorial-vocabulary-family-shape-v2';
import type { PolicyCase } from './editorial-vocabulary-policy-shape-v2';
import type { VocabularyV2 } from './editorial-vocabulary-shape-v2';

const codes = ['a', '\uE000', '😀']; // UTF-8 order; default UTF-16 reverses the last two.
function binding(code: string, sortOrder = 0): BindingV2 {
  return {
    definitionId: code,
    definitionCode: code,
    sortOrder,
    owner: 'product',
    exposure: 'DETAIL',
    searchable: false,
    publicationCheck: 'always',
    policy: { route: 'pending' },
  };
}
function policyCase(code: string, selected: string): PolicyCase {
  return {
    code,
    when: ['a', 'b'].map((definitionCode) => ({
      definitionCode,
      operator: 'equals_set',
      optionCodes: selected === 'a' ? codes.slice(1) : ['a'],
    })),
    applicability: 'applicable',
    required: false,
    allowNA: true,
    evidenceRequired: false,
    documentary: 'unresolved',
  };
}
function fixture(): VocabularyV2 {
  const bindings = ['a', 'b', 'c', 'd', 'e', 'f'].map((code) => binding(code));
  bindings[0].sortOrder = -Number.MAX_SAFE_INTEGER;
  bindings[5].sortOrder = Number.MAX_SAFE_INTEGER;
  bindings[2].policy = {
    route: 'option_cases',
    cases: [policyCase('a', 'a'), policyCase('z', 'z')],
  };
  bindings[3].policy = {
    route: 'fact_rule',
    rule: { family: 'food', ruleId: 'animal', parameter: 'animal.target' },
  };
  return {
    semanticsVersion: 'editorial-production-1',
    families: [
      { id: '1', code: 'a', label: 'A', minimumContractVersion: 1, bindings },
      {
        id: '2',
        code: 'b',
        label: 'A',
        minimumContractVersion: 2,
        bindings: [],
      },
      {
        id: '3',
        code: 'c',
        label: 'Z',
        minimumContractVersion: 2,
        bindings: [],
      },
    ],
    definitions: [
      ...['a', 'b'].map((code) => ({
        id: code,
        code,
        label: ' Original é ',
        type: 'multi' as const,
        options: codes.map((code) => ({
          code,
          label: code,
          archived: true,
          sortOrder: 0,
        })),
        groups: ['a', 'z'].map((code) => ({
          code,
          label: code,
          optionCodes: [...codes],
        })),
        aliases: [
          { label: 'Alias A', optionCode: 'a' },
          { label: 'Alias Z', optionCode: '😀' },
        ],
      })),
      { id: 'c', code: 'c', label: 'Text', type: 'text' },
      { id: 'd', code: 'd', label: 'Boolean', type: 'boolean' },
      {
        id: 'e',
        code: 'e',
        label: 'Number',
        type: 'number',
        numericPolicy: { status: 'pending' },
        units: [
          {
            code: 'first',
            label: 'First',
            sortOrder: -Number.MAX_SAFE_INTEGER,
          },
          { code: null, label: null, sortOrder: 0 },
          ...codes.map((code) => ({ code, label: code, sortOrder: 0 })),
          { code: 'last', label: 'Last', sortOrder: Number.MAX_SAFE_INTEGER },
        ],
      },
      {
        id: 'f',
        code: 'f',
        label: 'Range',
        type: 'range',
        units: codes.map((code) => ({ code, label: code, sortOrder: 0 })),
        numericPolicy: {
          status: 'resolved',
          magnitude: 'signed',
          integer: false,
          lower: null,
          lowerInclusive: false,
          upper: 10,
          upperInclusive: true,
        },
      },
      {
        id: 'g',
        code: 'g',
        label: 'Single',
        type: 'single',
        options: [],
        groups: [],
        aliases: [],
      },
    ],
  };
}
function set(input: unknown, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  const parent = keys.reduce(
    (v, k) => (v as Record<string, unknown>)[k],
    input,
  );
  (parent as Record<string, unknown>)[last] = value;
}
function walk(value: unknown, visit: (object: object) => void): void {
  if (value === null || typeof value !== 'object') return;
  Object.values(value).forEach((child) => walk(child, visit));
  visit(value);
}
function permute(input: VocabularyV2, rotate = false): VocabularyV2 {
  const result = JSON.parse(JSON.stringify(input)) as VocabularyV2;
  walk(result, (value) => {
    if (Array.isArray(value)) {
      if (rotate && value.length) value.push(value.shift());
      else value.reverse();
    }
  });
  return result;
}
afterEach(() => jest.restoreAllMocks());

describe('generic V2 canonical arrays and content R (T3c S2/S19)', () => {
  it.each([false, true])(
    'orders every nested sortable array independently of permutation (rotate=%s)',
    (rotate) => {
      const expected = fixture();
      const input = permute(expected, rotate);
      expect(canonicalize(input)).toEqual(expected);
      expect(respond(input)).toEqual(respond(expected));
      expect(canonicalize(canonicalize(input))).toEqual(expected);
      expect(respond(canonicalize(input))).toEqual(respond(input));
    },
  );

  it('uses exact UTF-8, secondary keys and relational safe-integer ordering', () => {
    const input = fixture();
    set(input, 'families.0.label', '😀');
    set(input, 'families.1.label', '\uE000');
    expect(canonicalize(input).families.map((f) => f.code)).toEqual([
      'c',
      'b',
      'a',
    ]);
    set(input, 'definitions.0.options.0.sortOrder', Number.MAX_SAFE_INTEGER);
    set(input, 'definitions.0.options.2.sortOrder', -Number.MAX_SAFE_INTEGER);
    const first = canonicalize(input).definitions[0];
    if (first.type !== 'multi') throw new Error('fixture');
    expect(first.options.map((o) => o.code)).toEqual(['😀', '\uE000', 'a']);
  });

  it('hashes independent literal preimage bytes, never the R envelope', () => {
    const input = {
      semanticsVersion: 'editorial-production-1',
      families: [],
      definitions: [],
    };
    const bytes = Buffer.from(
      '{"contractVersion":2,"vocabulary":{"definitions":[],"families":[],"semanticsVersion":"editorial-production-1"}}',
      'utf8',
    );
    const digest =
      '9fc678a9aa00e5af0488da2ee75ed520ebe3a7911c14f23267bf0d5a607423a1';
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(digest);
    const spy = jest.spyOn(json, 'hashEditorialJson');
    expect(respond(input)).toEqual({
      contractVersion: 2,
      vocabularyRevision: `ev2-sha256-${digest}`,
      vocabulary: input,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ contractVersion: 2, vocabulary: input });
    expect(json.canonicalEditorialJson(spy.mock.calls[0][0])).toEqual(bytes);
  });

  it('validates once and deeply detaches frozen metadata without mutating its input', () => {
    const input = fixture();
    const before = JSON.parse(JSON.stringify(input)) as VocabularyV2;
    const originals = new Set<object>();
    walk(input, (object) => {
      originals.add(object);
      Object.freeze(object);
    });
    const spy = jest.spyOn(consistency, 'validateVocabularyConsistencyV2');
    const output = respond(input);
    expect(spy).toHaveBeenCalledTimes(1);
    walk(output.vocabulary, (object) =>
      expect(originals.has(object)).toBe(false),
    );
    set(
      output.vocabulary,
      'families.0.bindings.2.policy.cases.0.allowNA',
      false,
    );
    set(output.vocabulary, 'definitions.0.groups.0.optionCodes.0', 'changed');
    set(output.vocabulary, 'definitions.4.units.0.label', 'changed');
    expect(input).toEqual(before);
  });

  it.each([
    ['families.0.id', 'other'],
    ['families.0.label', 'Changed'],
    ['families.0.minimumContractVersion', 2],
    ['families.0.bindings.0.owner', 'sellable'],
    ['families.0.bindings.0.exposure', 'FACET'],
    ['families.0.bindings.0.searchable', true],
    ['families.0.bindings.0.sortOrder', -4],
    ['families.0.bindings.0.publicationCheck', 'when_asserted'],
    ['definitions.6.id', 'other-unbound-id'],
    ['definitions.0.label', ' Original é '],
    ['definitions.0.options.0.archived', false],
    ['definitions.0.options.0.label', 'New'],
    ['definitions.0.options.0.sortOrder', 1],
    ['definitions.0.groups.0.label', 'New'],
    ['definitions.0.aliases.0.label', 'Other alias'],
    ['definitions.4.units.0.label', 'New'],
    ['definitions.5.numericPolicy.lower', -10],
    ['definitions.5.numericPolicy.upper', 20],
    ['definitions.5.numericPolicy.magnitude', 'other'],
    ['definitions.5.numericPolicy.integer', true],
    ['definitions.5.numericPolicy.upperInclusive', false],
    ['families.0.bindings.2.policy.cases.0.allowNA', false],
    ['families.0.bindings.2.policy.cases.0.code', 'different'],
    ['families.0.bindings.2.policy.cases.0.applicability', 'unresolved'],
    ['families.0.bindings.2.policy.cases.0.required', true],
    ['families.0.bindings.2.policy.cases.0.evidenceRequired', true],
    ['families.0.bindings.2.policy.cases.0.documentary', 'resolved'],
  ])('includes explicit field %s in R without normalization', (path, value) => {
    const input = fixture();
    const before = respond(input).vocabularyRevision;
    set(input, path, value);
    expect(respond(input).vocabularyRevision).not.toBe(before);
  });

  it('accepts empty/custom/unbound generic metadata without S18 or seven-family admission', () => {
    const input = fixture();
    expect(respond(input).vocabulary).toEqual(input); // V1 declaration with resolved policy is deliberately generic.
    input.families = [];
    expect(canonicalize(input)).toEqual(input);
    input.definitions = [];
    expect(canonicalize(input)).toEqual(input);
  });

  it.each([
    ['id', 'db'],
    ['contractVersion', 2],
    ['vocabularyRevision', 'R'],
    ['definitions.0.extra', true],
    ['families.0.bindings.0.extra', true],
    ['definitions.1.id', 'a'],
    ['definitions.1.code', 'a'],
    ['families.1.id', '1'],
    ['families.1.code', 'a'],
    ['families.0.bindings.0.definitionId', 'missing'],
    ['definitions.0.groups.0.optionCodes', ['missing']],
    ['definitions.0.aliases.1.label', 'Alias A'],
    ['families.0.bindings.2.policy.cases.1', policyCase('z', 'a')],
    ['families.0.bindings.2.policy.cases.0.when.0.optionCodes', ['missing']],
    ['families.0.bindings.2.policy.cases.0.applicability', 'not_applicable'],
    ['definitions.0.label', '\uD800'],
    ['definitions.4.units.0.sortOrder', Infinity],
  ])('rejects %s before hashing through both APIs', (path, value) => {
    const input = fixture();
    set(input, path, value);
    if (path.endsWith('applicability'))
      set(input, 'families.0.bindings.2.policy.cases.0.required', true);
    const hash = jest.spyOn(json, 'hashEditorialJson');
    expect(() => canonicalize(input)).toThrow(TypeError);
    expect(() => respond(input)).toThrow(TypeError);
    expect(hash).not.toHaveBeenCalled();
  });

  it('preserves inherited Unicode error identity without hashing', () => {
    const error = new Error('Unsupported Unicode runtime');
    jest
      .spyOn(consistency, 'validateVocabularyConsistencyV2')
      .mockImplementation(() => {
        throw error;
      });
    const hash = jest.spyOn(json, 'hashEditorialJson');
    for (const api of [canonicalize, respond]) {
      try {
        api(fixture());
        throw new Error('Expected rejection');
      } catch (caught) {
        expect(caught).toBe(error);
      }
    }
    expect(hash).not.toHaveBeenCalled();
  });
});
