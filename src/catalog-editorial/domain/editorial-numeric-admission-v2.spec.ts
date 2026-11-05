import { assertFreshNumericAdmissionV2 as admit } from './editorial-numeric-admission-v2';
import * as numeric from './editorial-numeric-payload-v2';
import type { KnownPayloadV2 } from './editorial-known-payload-shape-v2';
import type { ValueV2 } from './editorial-value-shape-v2';
import type { DefinitionV2 } from './editorial-vocabulary-definition-v2';
import type {
  BindingV2,
  FamilyV2,
} from './editorial-vocabulary-family-shape-v2';
import type {
  NumericDefinitionV2,
  NumericPolicyV2,
} from './editorial-vocabulary-numeric-v2';

const resolved: NumericPolicyV2 = {
  status: 'resolved',
  magnitude: 'custom',
  integer: true,
  lower: 0,
  lowerInclusive: true,
  upper: 10,
  upperInclusive: true,
};
const scalar = (value = 2): KnownPayloadV2 => ({
  type: 'number',
  value,
  unit: null,
});
const range = (min = 2, max = 3): KnownPayloadV2 => ({
  type: 'range',
  min,
  max,
  unit: 'cm',
});
function value(
  code: string,
  payload: KnownPayloadV2,
  variantId: string | null = 'inactive',
): ValueV2 {
  return {
    code,
    owner: 'sellable',
    variantId,
    state: 'known',
    payload,
    evidence: null,
  };
}
function fixture(type: 'number' | 'range' = 'number', policy = resolved) {
  const definition: NumericDefinitionV2 = {
    id: 'db/actual',
    code: 'custom.numeric',
    label: 'Numeric',
    type,
    units: [
      {
        code: type === 'number' ? null : 'cm',
        label: type === 'number' ? null : 'cm',
        sortOrder: 0,
      },
    ],
    numericPolicy: policy,
  };
  const binding: BindingV2 = {
    definitionId: definition.id,
    definitionCode: definition.code,
    owner: 'sellable',
    sortOrder: 0,
    exposure: 'INTERNAL',
    searchable: false,
    publicationCheck: 'when_asserted',
    policy: { route: 'pending' },
  };
  const family: FamilyV2 = {
    id: 'family',
    code: 'custom',
    label: 'Custom',
    bindings: [binding],
  };
  const definitions = new Map<string, DefinitionV2>([
    [definition.id, definition],
  ]);
  return { definition, binding, family, definitions };
}
function freeze(input: unknown): void {
  if (input && typeof input === 'object') {
    Object.values(input).forEach(freeze);
    Object.freeze(input);
  }
}
afterEach(() => jest.restoreAllMocks());

it.each(['binding', 'definition', 'type'] as const)(
  'guards a broken admitted-input precondition: %s',
  (broken) => {
    const f = fixture();
    if (broken === 'binding') f.family.bindings = [];
    if (broken === 'definition') f.definitions.clear();
    if (broken === 'type')
      f.definitions.set(f.definition.id, {
        id: f.definition.id,
        code: f.definition.code,
        label: 'Wrong',
        type: 'boolean',
      });
    expect(() =>
      admit(
        [value(f.definition.code, scalar())],
        f.family,
        f.definitions,
        'publish',
      ),
    ).toThrow(TypeError);
  },
);

describe.each(['save', 'publish'] as const)(
  'fresh numeric traversal on %s',
  (operation) => {
    it.each(['number', 'range'] as const)(
      'uses the actual bound ID and delegates %s unchanged',
      (type) => {
        const f = fixture(type);
        // A code-keyed fallback would pick an unrelated pending definition.
        f.definitions.set(f.definition.code, {
          ...f.definition,
          id: 'unrelated',
          code: 'other',
          numericPolicy: { status: 'pending' },
        });
        const row = value(
          f.definition.code,
          type === 'number' ? scalar() : range(),
        );
        const spy = jest.spyOn(numeric, 'freshNumericPayloadProblemV2');
        expect(
          admit([row], f.family, f.definitions, operation),
        ).toBeUndefined();
        expect(spy).toHaveBeenCalledTimes(1);
        if (row.state !== 'known') throw new Error('Expected known fixture');
        expect(spy.mock.calls[0][0]).toBe(row.payload);
        expect(spy.mock.calls[0][1]).toBe(f.definition.numericPolicy);
        expect(spy.mock.calls[0][2]).toBe(operation);
      },
    );

    it.each([
      ['product', null],
      ['sellable', null],
      ['sellable', 'inactive'],
      ['sellable', 'active'],
    ] as const)('does not exempt %s/%s subjects', (owner, variantId) => {
      const f = fixture();
      f.binding.owner = owner;
      const row = { ...value(f.definition.code, scalar(11), variantId), owner };
      expect(() => admit([row], f.family, f.definitions, operation)).toThrow(
        /^MALFORMED$/,
      );
    });

    it.each(['always', 'when_asserted'] as const)(
      'does not exempt %s or selected nonpertinence',
      (publicationCheck) => {
        const f = fixture();
        f.binding.publicationCheck = publicationCheck;
        f.binding.policy = {
          route: 'option_cases',
          cases: [
            {
              code: 'negative',
              when: [],
              applicability: 'not_applicable',
              required: false,
              allowNA: true,
              evidenceRequired: false,
              documentary: 'resolved',
            },
          ],
        };
        expect(() =>
          admit(
            [value(f.definition.code, scalar(11))],
            f.family,
            f.definitions,
            operation,
          ),
        ).toThrow(/^MALFORMED$/);
      },
    );

    it('visits multiple assertions and rejects a later invalid value', () => {
      const f = fixture();
      const rows = [
        value(f.definition.code, scalar(2), 'first'),
        value(f.definition.code, scalar(12), 'later'),
      ];
      const spy = jest.spyOn(numeric, 'freshNumericPayloadProblemV2');
      expect(() => admit(rows, f.family, f.definitions, operation)).toThrow(
        /^MALFORMED$/,
      );
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it.each([range(3, 2), range(-1, 3), range(2, 11), range(2, 2.5)])(
      'delegates range rejection %j',
      (payload) => {
        const f = fixture('range');
        expect(() =>
          admit(
            [value(f.definition.code, payload)],
            f.family,
            f.definitions,
            operation,
          ),
        ).toThrow(/^MALFORMED$/);
      },
    );

    it('skips nonknown and nonnumeric assertions without consulting numeric metadata', () => {
      const f = fixture();
      const payloads: KnownPayloadV2[] = [
        { type: 'text', value: 'text' },
        { type: 'boolean', value: false },
        { type: 'single', value: 'option' },
        { type: 'multi', value: ['option'] },
      ];
      const rows: ValueV2[] = [
        {
          code: f.definition.code,
          owner: 'sellable',
          variantId: 'u',
          state: 'unknown',
          evidence: null,
        },
        {
          code: f.definition.code,
          owner: 'sellable',
          variantId: 'na',
          state: 'not_applicable',
          evidence: null,
        },
        ...payloads.map((payload, i) => value(`nonnumeric.${i}`, payload)),
      ];
      const lookup = jest.spyOn(f.definitions, 'get');
      const spy = jest.spyOn(numeric, 'freshNumericPayloadProblemV2');
      expect(admit(rows, f.family, f.definitions, operation)).toBeUndefined();
      expect(admit([], f.family, f.definitions, operation)).toBeUndefined();
      expect(spy).not.toHaveBeenCalled();
      expect(lookup).not.toHaveBeenCalled();
    });

    it('preserves frozen inputs on success and failure', () => {
      const f = fixture();
      const rows = [value(f.definition.code, scalar(-0))];
      freeze(rows);
      freeze(f.family);
      freeze(f.definition);
      const before = structuredClone({
        rows,
        family: f.family,
        definitions: [...f.definitions],
      });
      expect(admit(rows, f.family, f.definitions, operation)).toBeUndefined();
      const invalid = [value(f.definition.code, scalar(11))];
      freeze(invalid);
      const invalidBefore = structuredClone(invalid);
      expect(() => admit(invalid, f.family, f.definitions, operation)).toThrow(
        /^MALFORMED$/,
      );
      expect({
        rows,
        family: f.family,
        definitions: [...f.definitions],
      }).toEqual(before);
      expect(invalid).toEqual(invalidBefore);
    });

    it('propagates an unexpected leaf error by identity', () => {
      const f = fixture();
      const error = new Error('unexpected leaf failure');
      jest
        .spyOn(numeric, 'freshNumericPayloadProblemV2')
        .mockImplementation(() => {
          throw error;
        });
      let caught: unknown;
      try {
        admit(
          [value(f.definition.code, scalar())],
          f.family,
          f.definitions,
          operation,
        );
      } catch (failure) {
        caught = failure;
      }
      expect(caught).toBe(error);
    });
  },
);

it.each(['number', 'range'] as const)(
  'retains S33 pending %s save/publish distinction',
  (type) => {
    const f = fixture(type, { status: 'pending' });
    const row = value(
      f.definition.code,
      type === 'number' ? scalar(-2.5) : range(-2.5, 0),
    );
    expect(admit([row], f.family, f.definitions, 'save')).toBeUndefined();
    expect(() => admit([row], f.family, f.definitions, 'publish')).toThrow(
      /^MALFORMED$/,
    );
  },
);

it('does not waive range order for pending saves', () => {
  const f = fixture('range', { status: 'pending' });
  expect(() =>
    admit(
      [value(f.definition.code, range(3, 2))],
      f.family,
      f.definitions,
      'save',
    ),
  ).toThrow(/^MALFORMED$/);
});
