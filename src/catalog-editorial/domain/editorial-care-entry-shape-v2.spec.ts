import {
  CareRequirementV2,
  CareWarningV2,
  parseCareRequirementShapeV2,
  parseCareWarningShapeV2,
} from './editorial-care-entry-shape-v2';

const evidence = () => ({ sourceRef: '', verifiedOn: 'not-a-date' });
const requirement = (): CareRequirementV2 => ({
  key: '',
  description: '\ud800',
  disposition: 'unresolved',
  evidence: [evidence(), evidence()],
  basis: ' ',
});
const warning = (): CareWarningV2 => ({
  key: '\ud800',
  requirementKeys: ['absent', '', 'absent'],
  text: '',
  disclosure: 'public_required',
  evidence: [evidence(), evidence()],
  handlingBasis: ' ',
});
const parentError = new TypeError('Expected a care entry shape V2');
const leafError = new TypeError('Expected an evidence shape V2');
const branches = [
  {
    name: 'requirement',
    parse: parseCareRequirementShapeV2,
    make: requirement,
  },
  { name: 'warning', parse: parseCareWarningShapeV2, make: warning },
];

it.each(['satisfied', 'not_applicable', 'unresolved', 'conflicting'] as const)(
  'accepts disposition %s without admission',
  (disposition) => {
    const input = { ...requirement(), disposition };
    expect(parseCareRequirementShapeV2(input)).toEqual(input);
  },
);
it.each(['private_only', 'public_required', 'unresolved'] as const)(
  'accepts disclosure %s without publication permission',
  (disclosure) => {
    const input = { ...warning(), disclosure };
    expect(parseCareWarningShapeV2(input)).toEqual(input);
  },
);

describe.each(branches)('$name closed primitive shape', ({ parse, make }) => {
  it('detaches frozen roots, arrays and duplicate nested evidence', () => {
    const input = make();
    input.evidence.forEach(Object.freeze);
    Object.freeze(input.evidence);
    if ('requirementKeys' in input) Object.freeze(input.requirementKeys);
    Object.freeze(input);
    const output = parse(input);
    expect(output).toEqual(input);
    expect(output).not.toBe(input);
    expect(output.evidence).not.toBe(input.evidence);
    expect(output.evidence[0]).not.toBe(input.evidence[0]);
    output.evidence[0].sourceRef = 'changed';
    output.evidence.push(evidence());
    if ('requirementKeys' in output && 'requirementKeys' in input) {
      expect(output.requirementKeys).not.toBe(input.requirementKeys);
      output.requirementKeys.push('changed');
      expect(input.requirementKeys).toEqual(['absent', '', 'absent']);
    }
    expect(input.evidence).toEqual([evidence(), evidence()]);
  });

  it('accepts empty arrays and null-prototype objects', () => {
    const input = { ...make(), evidence: [] };
    if ('requirementKeys' in input) input.requirementKeys = [];
    expect(parse(Object.assign(Object.create(null), input))).toEqual(input);
    const nested = make();
    nested.evidence = [
      Object.assign(Object.create(null) as object, evidence()),
    ];
    expect(parse(nested)).toEqual(nested);
  });

  it.each([null, undefined, true, 3, 'entry', [], new Date(0)])(
    'rejects invalid root %p',
    (input) => expect(() => parse(input)).toThrow(parentError),
  );

  it('requires every key and rejects extras, symbols and hidden properties', () => {
    for (const key of Object.keys(make())) {
      const input: Record<string, unknown> = { ...make() };
      delete input[key];
      expect(() => parse(input)).toThrow(parentError);
    }
    for (const key of ['extra', Symbol('extra')]) {
      expect(() => parse({ ...make(), [key]: '' })).toThrow(parentError);
    }
    const hidden = Object.defineProperty(make(), 'key', { enumerable: false });
    expect(() => parse(hidden)).toThrow(parentError);
  });

  it('rejects non-string fields and invalid enums', () => {
    for (const [key, value] of Object.entries(make())) {
      if (typeof value !== 'string') continue;
      for (const invalid of [null, 1, false, {}, new String('x')]) {
        expect(() => parse({ ...make(), [key]: invalid })).toThrow(parentError);
      }
    }
    const enumKey = 'disposition' in make() ? 'disposition' : 'disclosure';
    expect(() => parse({ ...make(), [enumKey]: 'other' })).toThrow(parentError);
  });

  it('preserves the evidence leaf rejection message', () => {
    for (const item of [
      null,
      {},
      { ...evidence(), verifiedOn: 1 },
      new Date(0),
    ]) {
      expect(() => parse({ ...make(), evidence: [item] })).toThrow(leafError);
    }
  });

  it('rejects root and evidence accessors without executing getters', () => {
    const getter = jest.fn(() => 'unexpected');
    for (const key of Object.keys(make())) {
      const input = Object.defineProperty(make(), key, { get: getter });
      expect(() => parse(input)).toThrow(parentError);
    }
    const item = Object.defineProperty(evidence(), 'sourceRef', {
      get: getter,
    });
    expect(() => parse({ ...make(), evidence: [item] })).toThrow(leafError);
    expect(getter).not.toHaveBeenCalled();
  });
});

const arrayPaths = [
  {
    name: 'requirement evidence',
    parse: parseCareRequirementShapeV2,
    make: requirement,
    key: 'evidence',
    item: evidence(),
  },
  {
    name: 'warning evidence',
    parse: parseCareWarningShapeV2,
    make: warning,
    key: 'evidence',
    item: evidence(),
  },
  {
    name: 'warning references',
    parse: parseCareWarningShapeV2,
    make: warning,
    key: 'requirementKeys',
    item: '',
  },
];
describe.each(arrayPaths)(
  '$name dense plain array',
  ({ parse, make, key, item }) => {
    it('rejects non-arrays, holes, decorations, symbols, hidden indices and exotic arrays', () => {
      const decorated = Object.assign([item], { extra: true });
      const symbolic = Object.assign([item], { [Symbol('extra')]: true });
      const hidden = Object.defineProperty([item], '0', { enumerable: false });
      const exotic: unknown = Object.setPrototypeOf([item], null);
      for (const array of [
        null,
        {},
        'array',
        new Array<unknown>(1),
        decorated,
        symbolic,
        hidden,
        exotic,
      ]) {
        expect(() => parse({ ...make(), [key]: array })).toThrow(parentError);
      }
      const hiddenExtra = Object.defineProperty([item], 'extra', {
        value: true,
      });
      expect(() => parse({ ...make(), [key]: hiddenExtra })).toThrow(
        parentError,
      );
    });

    it('never executes an array index getter', () => {
      const getter = jest.fn(() => item);
      const array = Object.defineProperty([item], '0', { get: getter });
      expect(() => parse({ ...make(), [key]: array })).toThrow(parentError);
      expect(getter).not.toHaveBeenCalled();
    });
  },
);

it.each([null, 1, false, {}, []])(
  'rejects non-string requirement reference %p',
  (item) => {
    expect(() =>
      parseCareWarningShapeV2({ ...warning(), requirementKeys: [item] }),
    ).toThrow(parentError);
  },
);

describe.each(branches)('$name reflection identity', ({ parse, make }) => {
  it.each([new Error('reflection'), parentError, Symbol('sentinel')])(
    'propagates %p from root, arrays and evidence',
    (sentinel) => {
      const throws = () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- Verify non-Error identity too.
        throw sentinel;
      };
      for (const trap of [
        'getPrototypeOf',
        'ownKeys',
        'getOwnPropertyDescriptor',
      ]) {
        const root = new Proxy(make(), { [trap]: throws });
        const nested = {
          ...make(),
          evidence: [new Proxy(evidence(), { [trap]: throws })],
        };
        const array = {
          ...make(),
          evidence: new Proxy([evidence()], { [trap]: throws }),
        };
        const inputs: unknown[] = [root, nested, array];
        if ('requirementKeys' in make()) {
          inputs.push({
            ...make(),
            requirementKeys: new Proxy([''], { [trap]: throws }),
          });
        }
        for (const input of inputs) {
          let caught: unknown;
          try {
            parse(input);
          } catch (error) {
            caught = error;
          }
          expect(caught).toBe(sentinel);
        }
      }
    },
  );
});
