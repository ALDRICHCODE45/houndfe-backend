import { validateVocabularyConsistencyV2 as validate } from './editorial-vocabulary-consistency-v2';
import type { DefinitionV2 } from './editorial-vocabulary-definition-v2';
import * as definitions from './editorial-vocabulary-definition-v2';
import * as references from './editorial-vocabulary-family-references-v2';
import * as consistency from './editorial-vocabulary-family-consistency-v2';
import * as staticCases from './editorial-vocabulary-option-case-static-v2';
import type { BindingV2 } from './editorial-vocabulary-family-shape-v2';
import type { PolicyCase } from './editorial-vocabulary-policy-shape-v2';
import type { VocabularyV2 } from './editorial-vocabulary-shape-v2';

function policyCase(selector = 'root'): PolicyCase {
  return {
    code: 'case',
    when: [
      { definitionCode: selector, operator: 'equals_set', optionCodes: ['z'] },
    ],
    applicability: 'applicable',
    required: false,
    allowNA: true,
    evidenceRequired: false,
    documentary: 'unresolved',
  };
}
function binding(code: string): BindingV2 {
  return {
    definitionId: `opaque/${code}`,
    definitionCode: code,
    owner: code === 'root' ? 'product' : 'sellable',
    sortOrder: -2,
    exposure: 'INTERNAL',
    searchable: false,
    publicationCheck: 'always',
    policy: { route: 'pending' },
  };
}
function fixture(): VocabularyV2 {
  const bindings = ['leaf', 'middle', 'root'].map(binding);
  bindings[0].policy = { route: 'option_cases', cases: [policyCase('middle')] };
  bindings[1].policy = { route: 'option_cases', cases: [policyCase()] };
  return {
    semanticsVersion: 'editorial-production-1',
    families: [
      {
        id: 'opaque/family',
        code: 'custom',
        label: ' Original ',
        bindings,
      },
    ],
    definitions: ['root', 'middle', 'leaf', 'unbound'].map(
      (code): DefinitionV2 => ({
        id: `opaque/${code}`,
        code,
        label: ' Original ',
        type: 'single',
        options: [
          { code: 'z', label: 'Last', archived: true, sortOrder: 8 },
          { code: 'a', label: 'First', archived: false, sortOrder: -1 },
        ],
        groups: [{ code: 'group', label: ' Group ', optionCodes: ['z', 'a'] }],
        aliases: [{ label: ' Alias ', optionCode: 'z' }],
      }),
    ),
  };
}
function cases(input: VocabularyV2): PolicyCase[] {
  const policy = input.families[0].bindings[0].policy;
  if (policy.route !== 'option_cases') throw new Error('fixture');
  return policy.cases;
}
// JSON fixtures must retain this Jest realm's plain-object/array prototypes.
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function freeze(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  Object.values(value).forEach(freeze);
  Object.freeze(value);
}
function detached(output: unknown, input: unknown): void {
  if (input === null || typeof input !== 'object') return;
  expect(output).not.toBe(input);
  for (const key of Object.keys(input))
    detached(
      (output as Record<string, unknown>)[key],
      (input as Record<string, unknown>)[key],
    );
}
function capture(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected rejection');
}
afterEach(() => jest.restoreAllMocks());

describe('validateVocabularyConsistencyV2 generic integration', () => {
  it('accepts empty roots and unbound definitions', () => {
    const input = fixture();
    input.families = [];
    expect(validate(input)).toEqual(input);
    input.definitions = [];
    expect(validate(input)).toEqual(input);
  });

  it('preserves detached frozen custom chains, owners, archives, pending roots and nonexhaustive cases', () => {
    const input = fixture();
    const before = structuredClone(input);
    freeze(input);
    const output = validate(input);
    expect(output).toEqual(before);
    detached(output, input);
    output.families[0].bindings.reverse();
    const choice = output.definitions[0];
    if (choice.type !== 'single') throw new Error('fixture');
    choice.groups[0].optionCodes.push('changed');
    expect(input).toEqual(before);
  });

  it('does not mistake production-looking names for production completeness', () => {
    const input = fixture();
    input.families[0].code = 'food';
    input.families[0].bindings = [];
    expect(validate(input)).toEqual(input);
  });

  it.each([
    'bad-root',
    'family-id',
    'family-code',
    'definition-id',
    'definition-code',
  ])('root parsing rejects %s before any trusted helper', (kind) => {
    const input = fixture();
    // A contextual defect must not hide root rejection.
    input.families[0].bindings[0].definitionId = 'missing';
    if (kind.startsWith('family')) {
      const other = copy(input.families[0]);
      other.id = kind === 'family-id' ? other.id : 'other';
      other.code = kind === 'family-code' ? other.code : 'other';
      input.families.push(other);
    }
    if (kind.startsWith('definition')) {
      const other = copy(input.definitions[0]);
      other.id = kind === 'definition-id' ? other.id : 'other';
      other.code = kind === 'definition-code' ? other.code : 'other';
      input.definitions.push(other);
    }
    const spies = [
      jest.spyOn(references, 'assertFamilyReferencesV2'),
      jest.spyOn(consistency, 'assertFamilyPolicyConsistencyV2'),
      jest.spyOn(staticCases, 'assertFamilyOptionCaseStaticV2'),
    ];
    expect(() =>
      validate(kind === 'bad-root' ? { ...input, extra: true } : input),
    ).toThrow(new TypeError('Expected a vocabulary shape V2'));
    spies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
  });

  it.each([
    'binding-id',
    'binding-code',
    'wrong-type',
    'not-bound',
    'unknown-option',
    'self',
    'cycle',
  ])('reference composition rejects %s before policy/static checks', (kind) => {
    const input = fixture();
    const bindings = input.families[0].bindings;
    if (kind === 'binding-id') bindings[0].definitionId = 'leaf';
    if (kind === 'binding-code') bindings[0].definitionCode = 'wrong';
    if (kind === 'wrong-type')
      input.definitions[1] = {
        id: 'opaque/middle',
        code: 'middle',
        label: 'Middle',
        type: 'text',
      };
    if (kind === 'not-bound')
      cases(input)[0].when[0].definitionCode = 'unbound';
    if (kind === 'unknown-option')
      cases(input)[0].when[0].optionCodes = ['missing'];
    if (kind === 'self') cases(input)[0].when[0].definitionCode = 'leaf';
    if (kind === 'cycle')
      bindings[2].policy = {
        route: 'option_cases',
        cases: [policyCase('leaf')],
      };
    // Also inconsistent: reference failures must win.
    cases(input)[0].required = true;
    cases(input)[0].applicability = 'unresolved';
    const policySpy = jest.spyOn(
      consistency,
      'assertFamilyPolicyConsistencyV2',
    );
    const staticSpy = jest.spyOn(staticCases, 'assertFamilyOptionCaseStaticV2');
    const before = structuredClone(input);
    freeze(input);
    expect(() => validate(input)).toThrow(
      new TypeError('Expected valid family references V2'),
    );
    expect(policySpy).not.toHaveBeenCalled();
    expect(staticSpy).not.toHaveBeenCalled();
    expect(input).toEqual(before);
  });

  it.each(['applicability', 'publication'])(
    'policy composition rejects required/%s inconsistency before static checks',
    (kind) => {
      const input = fixture();
      cases(input)[0].required = true;
      if (kind === 'applicability')
        cases(input)[0].applicability = 'not_applicable';
      else input.families[0].bindings[0].publicationCheck = 'when_asserted';
      // Also statically impossible: policy failure must win.
      cases(input)[0].when[0].optionCodes = ['z', 'a'];
      const spy = jest.spyOn(staticCases, 'assertFamilyOptionCaseStaticV2');
      expect(() => validate(input)).toThrow(
        new TypeError('Inconsistent family policy V2'),
      );
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it.each(['impossible', 'overlap'])(
    'static composition rejects %s without mutation',
    (kind) => {
      const input = fixture();
      if (kind === 'impossible')
        cases(input)[0].when[0].optionCodes = ['z', 'a'];
      else
        cases(input).push({
          ...copy(cases(input)[0]),
          code: 'later',
        });
      const before = structuredClone(input);
      freeze(input);
      const reason =
        kind === 'impossible' ? 'impossible case case' : 'overlap case/later';
      expect(() => validate(input)).toThrow(
        new TypeError(`Invalid family option cases V2: ${reason} in leaf`),
      );
      expect(input).toEqual(before);
    },
  );

  it.each(['reference', 'policy', 'static'])(
    'checks later families for %s failures in family-local order',
    (kind) => {
      const input = fixture();
      const later = copy(input.families[0]);
      later.id = 'later';
      later.code = 'later';
      input.families.push(later);
      const policy = later.bindings[0].policy;
      if (policy.route !== 'option_cases') throw new Error('fixture');
      if (kind === 'reference') later.bindings[0].definitionId = 'missing';
      if (kind === 'policy') {
        policy.cases[0].required = true;
        policy.cases[0].applicability = 'unresolved';
      }
      if (kind === 'static') policy.cases[0].when[0].optionCodes = ['z', 'a'];
      const calls: string[] = [];
      const ref = references.assertFamilyReferencesV2;
      const consistent = consistency.assertFamilyPolicyConsistencyV2;
      const stat = staticCases.assertFamilyOptionCaseStaticV2;
      jest
        .spyOn(references, 'assertFamilyReferencesV2')
        .mockImplementation((f, map) => {
          calls.push(`${f.code}:reference`);
          return ref(f, map);
        });
      jest
        .spyOn(consistency, 'assertFamilyPolicyConsistencyV2')
        .mockImplementation((f) => {
          calls.push(`${f.code}:policy`);
          return consistent(f);
        });
      jest
        .spyOn(staticCases, 'assertFamilyOptionCaseStaticV2')
        .mockImplementation((f, map) => {
          calls.push(`${f.code}:static`);
          return stat(f, map);
        });
      expect(() => validate(input)).toThrow(TypeError);
      const stages = ['reference', 'policy', 'static'];
      expect(calls).toEqual([
        ...stages.map((s) => `custom:${s}`),
        ...stages.slice(0, stages.indexOf(kind) + 1).map((s) => `later:${s}`),
      ]);
    },
  );

  it('propagates the real Unicode runtime failure and its exact error identity', () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      process.versions,
      'unicode',
    )!;
    try {
      Object.defineProperty(process.versions, 'unicode', {
        ...descriptor,
        value: '16.0',
      });
      const input = fixture();
      const direct = capture(() =>
        definitions.validateDefinitionV2(input.definitions[0]),
      );
      expect(direct).toBeInstanceOf(Error);
      expect(direct).not.toBeInstanceOf(TypeError);
      expect(capture(() => validate(input))).toEqual(direct);
      jest
        .spyOn(definitions, 'validateDefinitionV2')
        .mockImplementationOnce(() => {
          throw direct;
        });
      expect(capture(() => validate(input))).toBe(direct);
    } finally {
      Object.defineProperty(process.versions, 'unicode', descriptor);
    }
  });
});
