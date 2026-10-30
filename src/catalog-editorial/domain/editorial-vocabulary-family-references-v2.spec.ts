import {
  type DefinitionV2,
  validateDefinitionV2,
} from './editorial-vocabulary-definition-v2';
import { assertFamilyReferencesV2 } from './editorial-vocabulary-family-references-v2';
import { EditorialVocabularyRepresentationError } from './editorial-vocabulary-representation-error';
import {
  type BindingV2,
  parseFamilyShapeV2,
} from './editorial-vocabulary-family-shape-v2';
import type {
  BindingPolicy,
  OptionTest,
} from './editorial-vocabulary-policy-shape-v2';

const pending: BindingPolicy = { route: 'pending' };
const fact: BindingPolicy = {
  route: 'fact_rule',
  rule: { family: 'food', ruleId: 'animal', parameter: 'animal.target' },
};
function definition(code: string, type: DefinitionV2['type'] = 'single') {
  const base = { id: `opaque/${code}:id`, code, label: code, type };
  return validateDefinitionV2(
    type === 'single' || type === 'multi'
      ? {
          ...base,
          options: ['yes', 'no'].map((code, sortOrder) => ({
            code,
            label: code,
            archived: code === 'no',
            sortOrder,
          })),
          groups: [
            { code: 'group-only', label: 'Group', optionCodes: ['yes'] },
          ],
          aliases: [{ label: 'alias-only', optionCode: 'yes' }],
        }
      : type === 'number' || type === 'range'
        ? { ...base, units: [], numericPolicy: { status: 'pending' } }
        : base,
  );
}
function binding(code: string, policy: BindingPolicy = pending): BindingV2 {
  return {
    definitionId: `opaque/${code}:id`,
    definitionCode: code,
    owner: 'sellable',
    sortOrder: 0,
    exposure: 'INTERNAL',
    searchable: false,
    publicationCheck: 'when_asserted',
    policy,
  };
}
function cases(
  selectors: string[][],
  optionCodes = ['yes'],
  operator: OptionTest['operator'] = 'equals_set',
): BindingPolicy {
  return {
    route: 'option_cases',
    cases: selectors.map((codes, index) => ({
      code: `case-${index}`,
      when: codes.map((definitionCode) => ({
        definitionCode,
        operator,
        optionCodes,
      })),
      applicability: 'applicable',
      required: false,
      allowNA: false,
      evidenceRequired: false,
      documentary: 'resolved',
    })),
  };
}
function fixture(
  bindings: BindingV2[],
  definitions = bindings.map((b) => definition(b.definitionCode)),
) {
  return {
    family: parseFamilyShapeV2({
      id: 'opaque-family',
      code: 'legacy',
      label: 'Legacy',
      bindings,
    }),
    definitionsById: new Map(definitions.map((d) => [d.id, d])),
  };
}
function check(f: ReturnType<typeof fixture>) {
  return assertFamilyReferencesV2(f.family, f.definitionsById);
}
function freezeTree(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  Object.values(value).forEach(freezeTree);
  Object.freeze(value);
}

describe('assertFamilyReferencesV2 trusted-input reference assertion', () => {
  it('accepts an empty parsed family and returns void', () => {
    expect(check(fixture([]))).toBeUndefined();
  });

  it('preserves opaque IDs, unsorted and frozen inputs without mutation', () => {
    const f = fixture([binding('z', cases([['a']])), binding('a')]);
    const before = JSON.stringify([f.family, [...f.definitionsById]]);
    freezeTree(f.family);
    for (const d of f.definitionsById.values()) freezeTree(d);
    Object.freeze(f.definitionsById);
    expect(check(f)).toBeUndefined();
    expect(JSON.stringify([f.family, [...f.definitionsById]])).toBe(before);
  });

  describe.each([pending, fact, cases([[]])])('route $route', (policy) => {
    it('rejects a missing binding ID', () => {
      const f = fixture([binding('dependent', policy)]);
      f.definitionsById.clear();
      expect(() => check(f)).toThrow(TypeError);
    });
    it('rejects a binding code mismatched with its resolved definition', () => {
      const f = fixture([binding('dependent', policy)]);
      f.definitionsById.set('opaque/dependent:id', {
        ...definition('different-code'),
        id: 'opaque/dependent:id',
      });
      expect(() => check(f)).toThrow(TypeError);
    });
  });

  it('rejects a globally existing selector not bound in this family', () => {
    const f = fixture(
      [binding('dependent', cases([['selector']]))],
      [definition('dependent'), definition('selector')],
    );
    expect(() => check(f)).toThrow(TypeError);
  });

  it.each(['text', 'boolean', 'number', 'range'] as const)(
    'rejects %s selector definitions',
    (type) => {
      const f = fixture(
        [binding('d', cases([['s']])), binding('s')],
        [definition('d'), definition('s', type)],
      );
      expect(() => check(f)).toThrow(TypeError);
    },
  );

  describe.each(['single', 'multi'] as const)('%s selectors', (type) => {
    it.each(['equals_set', 'contains_all', 'intersects'] as const)(
      'accepts %s with several exact options including archived ones',
      (operator) => {
        const f = fixture(
          [binding('d', cases([['s']], ['no', 'yes'], operator)), binding('s')],
          [definition('d'), definition('s', type)],
        );
        expect(check(f)).toBeUndefined();
      },
    );
  });

  it.each(['unknown', 'alias-only', 'group-only', 'YES', ' yes '])(
    'rejects non-option identity %s without normalization or expansion',
    (code) => {
      const f = fixture([binding('d', cases([['s']], [code])), binding('s')]);
      expect(() => check(f)).toThrow(TypeError);
    },
  );

  it('does not accept an option belonging only to a different definition', () => {
    const foreign = validateDefinitionV2({
      id: 'foreign',
      code: 'foreign',
      label: 'Foreign',
      type: 'single',
      options: [
        {
          code: 'foreign-option',
          label: 'Foreign option',
          archived: false,
          sortOrder: 0,
        },
      ],
      groups: [],
      aliases: [],
    });
    const f = fixture(
      [binding('d', cases([['s']], ['foreign-option'])), binding('s')],
      [definition('d'), definition('s'), foreign],
    );
    expect(() => check(f)).toThrow(TypeError);
  });

  it.each([
    ['product', 'product', false],
    ['product', 'sellable', true],
    ['sellable', 'product', false],
    ['sellable', 'sellable', false],
  ] as const)(
    'admits owner edge %s → %s with rejection=%s without mutation',
    (targetOwner, selectorOwner, rejects) => {
      const f = fixture([
        { ...binding('d', cases([['s']])), owner: targetOwner },
        { ...binding('s'), owner: selectorOwner },
      ]);
      const before = JSON.stringify([f.family, [...f.definitionsById]]);
      freezeTree(f.family);
      for (const definition of f.definitionsById.values())
        freezeTree(definition);
      Object.freeze(f.definitionsById);
      if (rejects) {
        expect(() => check(f)).toThrow(EditorialVocabularyRepresentationError);
        expect(() => check(f)).toThrow('Expected valid family references V2');
      } else expect(check(f)).toBeUndefined();
      expect(JSON.stringify([f.family, [...f.definitionsById]])).toBe(before);
    },
  );

  it('rejects a sellable selector in a later case of a product target', () => {
    const f = fixture([
      { ...binding('d', cases([['p'], ['p', 's']])), owner: 'product' },
      { ...binding('p'), owner: 'product' },
      binding('s'),
    ]);
    expect(() => check(f)).toThrow(EditorialVocabularyRepresentationError);
  });

  it('allows sellable-to-product selectors, pending roots and fact rules without triple evaluation', () => {
    const selector = binding('s', fact);
    selector.owner = 'product';
    expect(
      check(
        fixture([binding('d', cases([['s']])), selector, binding('unused')]),
      ),
    ).toBeUndefined();
  });

  it.each([
    ['self', [['a']], ['a']],
    ['two-node', [['b'], ['a']], ['a', 'b']],
    ['long', [['b'], ['c'], ['d'], ['a']], ['a', 'b', 'c', 'd']],
    ['disconnected', [[], ['c'], ['b']], ['root', 'b', 'c']],
  ])('rejects %s cycles', (_name, edges, codes) => {
    const f = fixture(codes.map((code, i) => binding(code, cases([edges[i]]))));
    expect(() => check(f)).toThrow(TypeError);
  });

  it('unions dependencies across cases instead of checking each case separately', () => {
    const f = fixture([
      binding('a', cases([[], ['b']])),
      binding('b', cases([['a'], []])),
    ]);
    expect(() => check(f)).toThrow(TypeError);
  });

  it('checks later tests in later cases without mutating rejected inputs', () => {
    const f = fixture([
      binding('d', cases([['s'], ['s', 'unbound']])),
      binding('s'),
    ]);
    const before = JSON.stringify([f.family, [...f.definitionsById]]);
    freezeTree(f.family);
    for (const d of f.definitionsById.values()) freezeTree(d);
    Object.freeze(f.definitionsById);
    expect(() => check(f)).toThrow(TypeError);
    expect(JSON.stringify([f.family, [...f.definitionsById]])).toBe(before);
  });

  it('accepts a diamond with repeated edges across cases', () => {
    const f = fixture([
      binding('a', cases([['b', 'c'], ['b']])),
      binding('b', cases([['d']])),
      binding('c', cases([['d']])),
      binding('d'),
    ]);
    expect(check(f)).toBeUndefined();
  });

  it('accepts a large chain and rejects its cycle without recursion', () => {
    const size = 12000;
    const f = fixture(
      Array.from({ length: size }, (_, i) =>
        binding(`d${i}`, i + 1 === size ? pending : cases([[`d${i + 1}`]])),
      ),
    );
    expect(check(f)).toBeUndefined();
    // Closing the same long chain exercises cycle detection at the same scale.
    f.family = parseFamilyShapeV2({
      ...f.family,
      bindings: f.family.bindings.map((b, i) =>
        i + 1 === size ? { ...b, policy: cases([['d0']]) } : b,
      ),
    });
    expect(() => check(f)).toThrow(TypeError);
  });
});
