import * as familyParser from './editorial-vocabulary-family-shape-v2';
import type { BindingPolicy } from './editorial-vocabulary-policy-shape-v2';
import { materializeStoredFamilyV2 as materialize } from './editorial-vocabulary-stored-family-v2';

type Row = Record<string, unknown>;
const binding = (): Row => ({
  familyId: ' family ',
  definitionId: ' unresolved-id ',
  definitionCode: ' custom.code ',
  owner: 'product',
  sortOrder: -2,
  exposure: 'INTERNAL',
  searchable: false,
  publicationCheck: 'when_asserted',
  policy: { route: 'pending' },
});
const fixture = (): Row => ({
  id: ' family ',
  code: ' custom.family ',
  label: ' Café familiar ',
  minimumContractVersion: 1,
  bindings: [binding()],
});
const at = (row: Row): Row => (row.bindings as Row[])[0];
const optionPolicy = (): BindingPolicy => ({
  route: 'option_cases',
  cases: [
    {
      code: ' case ',
      when: [
        {
          definitionCode: ' unresolved.selector ',
          operator: 'intersects',
          optionCodes: ['z', ' A '],
        },
      ],
      applicability: 'unresolved',
      required: false,
      allowNA: true,
      evidenceRequired: true,
      documentary: 'unresolved',
    },
  ],
});
const policies: BindingPolicy[] = [
  { route: 'pending' },
  optionPolicy(),
  {
    route: 'fact_rule',
    rule: { family: 'food', ruleId: 'required', parameter: 'animal.target' },
  },
];
function wire(row: Row): Row {
  return {
    ...row,
    bindings: (row.bindings as Row[]).map((b) => ({
      definitionId: b.definitionId,
      definitionCode: b.definitionCode,
      owner: b.owner,
      sortOrder: b.sortOrder,
      exposure: b.exposure,
      searchable: b.searchable,
      publicationCheck: b.publicationCheck,
      policy: b.policy,
    })),
  };
}
function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}

describe('dormant stored family V2 materialization', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([1, 2])('preserves empty families at version %s', (version) => {
    const row = { ...fixture(), minimumContractVersion: version, bindings: [] };
    expect(materialize(row)).toEqual(row);
  });

  it.each(policies)(
    'preserves policy route $route and wire metadata',
    (policy) => {
      for (const minimumContractVersion of [1, 2]) {
        for (const owner of ['product', 'sellable']) {
          for (const exposure of ['INTERNAL', 'DETAIL', 'FACET']) {
            for (const publicationCheck of ['always', 'when_asserted']) {
              const row = { ...fixture(), minimumContractVersion };
              Object.assign(at(row), {
                owner,
                exposure,
                publicationCheck,
                searchable: owner === 'sellable',
                policy,
              });
              expect(materialize(row)).toEqual(wire(row));
            }
          }
        }
      }
    },
  );

  it('strips future storage columns, preserving binding order without mutation', () => {
    const row = fixture();
    (row.bindings as Row[]).push({
      ...binding(),
      definitionId: 'second-id',
      definitionCode: 'a',
      sortOrder: -10,
    });
    row.future = { nested: ['storage', null] };
    at(row).future = { enabled: true };
    const before = JSON.stringify(row);
    freeze(row);
    const result = materialize(row);
    expect(result).toEqual({
      id: row.id,
      code: row.code,
      label: row.label,
      minimumContractVersion: 1,
      bindings: wire(row).bindings,
    });
    expect(JSON.stringify(row)).toBe(before);
    expect(result.bindings.map((b) => b.definitionCode)).toEqual([
      ' custom.code ',
      'a',
    ]);
  });

  it('passes the whole policy by identity to the existing parser, which detaches it', () => {
    const row = fixture();
    at(row).policy = optionPolicy();
    freeze(row);
    const parser = jest.spyOn(familyParser, 'parseFamilyShapeV2');
    const result = materialize(row);
    expect(parser).toHaveBeenCalledTimes(1);
    const submitted = parser.mock.calls[0][0] as Row;
    expect(at(submitted).policy).toBe(at(row).policy);
    expect(result).toEqual(wire(row));
    expect(result).not.toBe(row);
    expect(result.bindings).not.toBe(row.bindings);
    expect(result.bindings[0]).not.toBe(at(row));
    expect(result.bindings[0].policy).not.toBe(at(row).policy);
    const policy = result.bindings[0].policy;
    if (policy.route !== 'option_cases') throw new Error('Wrong fixture route');
    policy.cases[0].when[0].optionCodes.push('changed');
    expect(at(row).policy).toEqual(optionPolicy());
  });

  it.each([null, [], 'family', 4])('rejects a nonrecord family: %p', (row) => {
    expect(() => materialize(row)).toThrow(TypeError);
  });

  it.each([null, {}, 'bindings', 4])(
    'requires a bindings array: %p',
    (bindings) => {
      expect(() => materialize({ ...fixture(), bindings })).toThrow(TypeError);
    },
  );

  it.each([null, [], 'binding', 4])('rejects nonrecord bindings: %p', (b) => {
    expect(() => materialize({ ...fixture(), bindings: [b] })).toThrow(
      TypeError,
    );
  });

  it.each(['other', null, 3])('rejects mismatched familyId: %p', (familyId) => {
    const row = fixture();
    at(row).familyId = familyId;
    expect(() => materialize(row)).toThrow(TypeError);
  });

  it('requires familyId even when both parent identities are absent', () => {
    for (const missingFamilyId of [false, true]) {
      const row = fixture();
      delete at(row).familyId;
      if (missingFamilyId) delete row.id;
      expect(() => materialize(row)).toThrow(TypeError);
    }
  });

  it.each([
    ['family', (row: Row) => row],
    ['binding', at],
  ] as const)('requires every mapped %s field', (_, select) => {
    for (const key of Object.keys(select(fixture()))) {
      const row = fixture();
      delete select(row)[key];
      expect(() => materialize(row)).toThrow(TypeError);
    }
  });

  it.each([
    ['id', ' '],
    ['minimumContractVersion', 3],
    ['label', null],
  ])('delegates invalid family %s', (key, value) => {
    expect(() => materialize({ ...fixture(), [key]: value })).toThrow(
      TypeError,
    );
  });

  it.each<[string, unknown]>([
    ['definitionId', ' '],
    ['definitionCode', null],
    ['owner', 'VARIANT'],
    ['sortOrder', Number.MAX_SAFE_INTEGER + 1],
    ['exposure', 'PUBLIC'],
    ['searchable', 'false'],
    ['publicationCheck', 'pending'],
    ['policy', { route: 'unknown' }],
    ...['policy', 'publicationCheck', 'exposure', 'searchable'].map<
      [string, unknown]
    >((key) => [key, null]),
  ])('delegates invalid binding %s=%p', (key, value) => {
    const row = fixture();
    at(row)[key] = value;
    expect(() => materialize(row)).toThrow(TypeError);
  });

  it.each(['definitionId', 'definitionCode'])('rejects duplicate %s', (key) => {
    const row = fixture();
    const second = {
      ...binding(),
      definitionId: 'other',
      definitionCode: 'other',
    };
    second[key] = at(row)[key];
    (row.bindings as Row[]).push(second);
    expect(() => materialize(row)).toThrow(TypeError);
  });

  it.each(policies)(
    'does not prune semantic policy extras at $route',
    (policy) => {
      const row = fixture();
      at(row).policy = { ...policy, future: true };
      expect(() => materialize(row)).toThrow(
        'Expected a binding policy shape V2',
      );
    },
  );

  it.each(['family', 'binding', 'future'])(
    'guards %s accessors before reads',
    (where) => {
      const row = fixture();
      row.future = {};
      const target =
        where === 'family' ? row : where === 'binding' ? at(row) : row.future;
      const getter = jest.fn(() => 'unexpected');
      Object.defineProperty(target, 'id', { enumerable: true, get: getter });
      expect(() => materialize(row)).toThrow(TypeError);
      expect(getter).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, new Date(0), () => null, NaN])(
    'rejects nonJSON future columns: %p',
    (future) => {
      expect(() => materialize({ ...fixture(), future })).toThrow(TypeError);
    },
  );

  it('propagates parser errors unchanged outside the raw guard catch', () => {
    const error = new Error('parser sentinel');
    jest.spyOn(familyParser, 'parseFamilyShapeV2').mockImplementation(() => {
      throw error;
    });
    expect(() => materialize(fixture())).toThrow(error);
    try {
      materialize(fixture());
    } catch (caught) {
      expect(caught).toBe(error);
    }
  });
});
