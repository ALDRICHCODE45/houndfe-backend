import { EditorialVocabularyRepresentationError } from './editorial-vocabulary-representation-error';
import { materializeStoredVocabularyV2 } from './editorial-vocabulary-stored-root-v2';
import { materializeStoredChoiceDefinitionV2 } from './editorial-vocabulary-stored-choice-v2';
import { materializeStoredScalarDefinitionV2 } from './editorial-vocabulary-stored-scalar-v2';
import { materializeStoredFamilyV2 } from './editorial-vocabulary-stored-family-v2';
import { validateSimpleDefinitionV2 } from './editorial-vocabulary-simple-v2';
import { validateNumericDefinitionV2 } from './editorial-vocabulary-numeric-v2';
import { parseChoiceDefinitionShapeV2 } from './editorial-vocabulary-choice-v2';
import { validateDefinitionV2 } from './editorial-vocabulary-definition-v2';
import { parseVocabularyShapeV2 } from './editorial-vocabulary-shape-v2';
import { parseFamilyShapeV2 } from './editorial-vocabulary-family-shape-v2';
import {
  parseBindingPolicyShapeV2,
  type PolicyCase,
} from './editorial-vocabulary-policy-shape-v2';
import { assertFamilyReferencesV2 } from './editorial-vocabulary-family-references-v2';
import { assertFamilyPolicyConsistencyV2 } from './editorial-vocabulary-family-consistency-v2';
import { assertFamilyOptionCaseStaticV2 } from './editorial-vocabulary-option-case-static-v2';
import { materializeHistoricalVocabularyResponseV2 } from './editorial-vocabulary-historical-v2';

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected rejection');
}

function expectRepresentation(run: () => unknown, message: string): void {
  const error = thrown(run);
  expect(error).toBeInstanceOf(EditorialVocabularyRepresentationError);
  expect(error).toBeInstanceOf(TypeError);
  expect(error).toMatchObject({ name: 'TypeError', message });
}

const guards: [string, (input: unknown) => unknown, string][] = [
  [
    'stored root',
    materializeStoredVocabularyV2,
    'a representable stored vocabulary',
  ],
  [
    'stored choice',
    materializeStoredChoiceDefinitionV2,
    'a representable stored choice definition',
  ],
  [
    'stored scalar',
    materializeStoredScalarDefinitionV2,
    'a representable stored scalar definition',
  ],
  ['stored family', materializeStoredFamilyV2, 'a representable stored family'],
  ['simple', validateSimpleDefinitionV2, 'a simple definition'],
  ['numeric', validateNumericDefinitionV2, 'a numeric definition'],
  ['choice', parseChoiceDefinitionShapeV2, 'a choice definition'],
  ['definition', validateDefinitionV2, 'a definition'],
  ['root shape', parseVocabularyShapeV2, 'a vocabulary shape'],
  ['family shape', parseFamilyShapeV2, 'a family shape'],
  ['policy shape', parseBindingPolicyShapeV2, 'a binding policy shape'],
];
const sentinels = [
  new Error('reflection failure'),
  new TypeError('Expected a finite, acyclic JSON data tree'),
  new RangeError('reflection failure'),
  Symbol('reflection failure'),
];

function reflectionFailure(sentinel: unknown, getter: () => never): object {
  return new Proxy(
    {
      get value() {
        return getter();
      },
    },
    {
      ownKeys() {
        throw sentinel;
      },
    },
  );
}

describe.each(guards)('%s canonical guard', (_name, parse, expected) => {
  it('classifies intentional invalid-tree and local shape rejection', () => {
    for (const input of [NaN, {}]) {
      expectRepresentation(() => parse(input), `Expected ${expected} V2`);
    }
  });

  it.each(sentinels)(
    'preserves unexpected reflection failure %p',
    (sentinel) => {
      const getter = jest.fn((): never => {
        throw new Error('Getter executed');
      });
      const error = thrown(() => parse(reflectionFailure(sentinel, getter)));
      expect(error).toBe(sentinel);
      expect(error).not.toBeInstanceOf(EditorialVocabularyRepresentationError);
      expect(getter).not.toHaveBeenCalled();
    },
  );
});

function graph(cases: PolicyCase[]) {
  const definitions = [
    validateDefinitionV2({
      id: 'selector-id',
      code: 'selector',
      label: 'Selector',
      type: 'single',
      options: ['a', 'b'].map((code) => ({
        code,
        label: code,
        archived: false,
        sortOrder: 0,
      })),
      groups: [],
      aliases: [],
    }),
    validateDefinitionV2({
      id: 'target-id',
      code: 'target',
      label: 'Target',
      type: 'text',
    }),
  ];
  const family = parseFamilyShapeV2({
    id: 'custom-id',
    code: 'custom',
    label: 'Custom',
    bindings: definitions.map((definition, index) => ({
      definitionId: definition.id,
      definitionCode: definition.code,
      owner: 'product',
      sortOrder: index,
      exposure: 'INTERNAL',
      searchable: false,
      publicationCheck: 'always',
      policy:
        index === 0 ? { route: 'pending' } : { route: 'option_cases', cases },
    })),
  });
  return { family, definitions: new Map(definitions.map((d) => [d.id, d])) };
}

function policyCase(code: string, optionCodes = ['a']): PolicyCase {
  return {
    code,
    when: [{ definitionCode: 'selector', operator: 'equals_set', optionCodes }],
    applicability: 'applicable',
    required: false,
    allowNA: false,
    evidenceRequired: false,
    documentary: 'resolved',
  };
}

describe('trusted parsed graph assertions', () => {
  it('classifies reference rejection', () => {
    const { family, definitions } = graph([policyCase('missing', ['missing'])]);
    expectRepresentation(
      () => assertFamilyReferencesV2(family, definitions),
      'Expected valid family references V2',
    );
  });

  it('classifies policy consistency rejection', () => {
    const { family, definitions } = graph([
      {
        ...policyCase('required'),
        required: true,
        applicability: 'not_applicable',
      },
    ]);
    assertFamilyReferencesV2(family, definitions);
    expectRepresentation(
      () => assertFamilyPolicyConsistencyV2(family),
      'Inconsistent family policy V2',
    );
  });

  it.each([
    [[policyCase('impossible', ['a', 'b'])], 'impossible case impossible'],
    [[policyCase('first'), policyCase('second')], 'overlap first/second'],
  ] as [PolicyCase[], string][])(
    'classifies static case rejection %p',
    (cases, reason) => {
      const { family, definitions } = graph(cases);
      assertFamilyReferencesV2(family, definitions);
      assertFamilyPolicyConsistencyV2(family);
      expectRepresentation(
        () => assertFamilyOptionCaseStaticV2(family, definitions),
        `Invalid family option cases V2: ${reason} in target`,
      );
    },
  );
});

it.each(sentinels)(
  'historical V2 composition preserves unexpected failure %p',
  (sentinel) => {
    const getter = jest.fn((): never => {
      throw new Error('Getter executed');
    });
    const input = {
      metadata: { id: 'global', semanticsVersion: 'editorial-production-1' },
      families: [],
      definitions: [],
      future: reflectionFailure(sentinel, getter),
    };
    expect(thrown(() => materializeHistoricalVocabularyResponseV2(input))).toBe(
      sentinel,
    );
    expect(getter).not.toHaveBeenCalled();
  },
);
