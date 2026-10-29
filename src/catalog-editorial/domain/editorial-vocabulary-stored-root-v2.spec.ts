import * as consistency from './editorial-vocabulary-consistency-v2';
import * as choice from './editorial-vocabulary-stored-choice-v2';
import * as family from './editorial-vocabulary-stored-family-v2';
import * as scalar from './editorial-vocabulary-stored-scalar-v2';
import { materializeStoredVocabularyV2 as materialize } from './editorial-vocabulary-stored-root-v2';

type Row = Record<string, unknown>;
const metadata = () => ({
  id: 'global',
  semanticsVersion: 'editorial-production-1',
});
const definition = (type = 'number', id = 'd') => ({
  id,
  code: `custom.${id}`,
  label: ` Label ${id} `,
  type,
  numericPolicy:
    type === 'number' || type === 'range' ? { status: 'pending' } : null,
  units:
    type === 'number' || type === 'range'
      ? [
          {
            id: `unit-${id}`,
            definitionId: id,
            definitionType: type,
            unitCode: 'cm',
            label: ' cm ',
            sortOrder: -2,
          },
        ]
      : [],
  options:
    type === 'single' || type === 'multi'
      ? [
          {
            definitionId: id,
            definitionType: type,
            code: 'a',
            label: ' A ',
            sortOrder: 3,
            archivedAt: null,
          },
        ]
      : [],
  groups:
    type === 'single' || type === 'multi'
      ? [
          {
            definitionId: id,
            definitionType: type,
            code: 'g',
            label: ' G ',
            members: [{ definitionId: id, groupCode: 'g', optionCode: 'a' }],
          },
        ]
      : [],
  aliases:
    type === 'single' || type === 'multi'
      ? [
          {
            definitionId: id,
            label: 'Alias',
            optionCode: 'a',
          },
        ]
      : [],
});
const fixture = () => ({
  metadata: metadata(),
  families: [
    {
      id: 'f',
      code: 'custom.family',
      label: ' Family ',
      minimumContractVersion: 1,
      bindings: [
        {
          familyId: 'f',
          definitionId: 'd',
          definitionCode: 'custom.d',
          owner: 'sellable',
          sortOrder: -3,
          exposure: 'DETAIL',
          searchable: false,
          publicationCheck: 'when_asserted',
          policy: { route: 'pending' },
        },
      ],
    },
  ],
  definitions: [definition()],
});
const empty = () => ({ metadata: metadata(), families: [], definitions: [] });
function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}
function rejects(value: unknown): void {
  expect(() => materialize(value)).toThrow(TypeError);
}

describe('dormant stored root V2 materialization', () => {
  afterEach(() => jest.restoreAllMocks());

  it('requires real metadata even for an empty vocabulary', () => {
    expect(materialize(empty())).toEqual({
      semanticsVersion: 'editorial-production-1',
      families: [],
      definitions: [],
    });
  });

  it('composes an explicit wire root and returns the generic detached result', () => {
    const row = fixture();
    const spy = jest.spyOn(consistency, 'validateVocabularyConsistencyV2');
    const output = materialize(row);
    expect(output).toBe(spy.mock.results[0].value);
    expect(spy).toHaveBeenCalledWith({
      semanticsVersion: 'editorial-production-1',
      families: row.families.map(family.materializeStoredFamilyV2),
      definitions: row.definitions.map(
        scalar.materializeStoredScalarDefinitionV2,
      ),
    });
    expect(output.families[0]).not.toHaveProperty('minimumContractVersion');
  });

  it.each([
    undefined,
    null,
    false,
    'global',
    [],
    {},
    { id: 'other', semanticsVersion: 'editorial-production-1' },
    { id: 'global', semanticsVersion: 'other' },
    { id: 'global' },
    { semanticsVersion: 'editorial-production-1' },
  ])('rejects absent or malformed metadata %#', (value) => {
    const row: Row = empty();
    if (value === undefined) delete row.metadata;
    else row.metadata = value;
    rejects(row);
  });

  it.each([
    null,
    [],
    false,
    'root',
    {},
    { ...empty(), families: null },
    { ...empty(), definitions: {} },
    { ...empty(), definitions: [null] },
    { ...empty(), definitions: [{ ...definition(), units: null }] },
  ])('rejects malformed raw root/scan shapes %#', rejects);

  it.each(['metadata', 'families', 'definitions', 'future'])(
    'guards raw accessors before executing getters: %s',
    (key) => {
      const row = fixture();
      const getter = jest.fn(() => {
        throw new Error('must not execute');
      });
      Object.defineProperty(row, key, { enumerable: true, get: getter });
      rejects(row);
      expect(getter).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, BigInt(1), NaN, () => 1, new Date()])(
    'guards even discarded non-JSON future fields %#',
    (future) => {
      const row = fixture();
      Object.assign(row.definitions[0].units[0], { future });
      const spy = jest.spyOn(family, 'materializeStoredFamilyV2');
      rejects(row);
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it('checks a nested accessor before any mapper runs', () => {
    const row = fixture();
    const getter = jest.fn(() => 'bad');
    Object.defineProperty(row.definitions[0].units[0], 'future', {
      get: getter,
    });
    const spy = jest.spyOn(family, 'materializeStoredFamilyV2');
    rejects(row);
    expect(getter).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });

  it('omits future storage fields but never prunes semantic policy extras', () => {
    const row = fixture();
    const expected = materialize(row);
    [
      row,
      row.metadata,
      row.families[0],
      row.families[0].bindings[0],
      row.definitions[0],
      row.definitions[0].units[0],
    ].forEach((value) =>
      Object.assign(value, { future: { retained: [null, 2] } }),
    );
    expect(materialize(row)).toEqual(expected);
    Object.assign(row.definitions[0].numericPolicy!, { future: true });
    rejects(row);
    row.definitions[0].numericPolicy = { status: 'pending' };
    Object.assign(row.families[0].bindings[0].policy, { future: true });
    rejects(row);
  });

  it.each(['duplicate', ''])(
    'rejects globally repeated raw unit ID %j',
    (id) => {
      const row = {
        ...empty(),
        definitions: [definition('number', 'x'), definition('range', 'y')],
      };
      row.definitions.forEach((d) => {
        d.units[0].id = id;
      });
      const spy = jest.spyOn(scalar, 'materializeStoredScalarDefinitionV2');
      rejects(row);
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it('allows distinct unit IDs, including one empty storage identity', () => {
    const row = {
      ...empty(),
      definitions: [definition('number', 'x'), definition('range', 'y')],
    };
    row.definitions[0].units[0].id = '';
    expect(materialize(row).definitions).toHaveLength(2);
  });

  it.each([null, 1, false])('rejects non-string raw unit identity %j', (id) => {
    const row = fixture();
    Object.assign(row.definitions[0].units[0], { id });
    rejects(row);
  });

  it.each(['text', 'boolean', 'number', 'range', 'single', 'multi'])(
    'dispatches %s through its existing leaf',
    (type) => {
      const row = { ...empty(), definitions: [definition(type)] };
      const choiceSpy = jest.spyOn(
        choice,
        'materializeStoredChoiceDefinitionV2',
      );
      const scalarSpy = jest.spyOn(
        scalar,
        'materializeStoredScalarDefinitionV2',
      );
      expect(materialize(row).definitions[0].type).toBe(type);
      expect(choiceSpy).toHaveBeenCalledTimes(
        type === 'single' || type === 'multi' ? 1 : 0,
      );
      expect(scalarSpy).toHaveBeenCalledTimes(
        type === 'single' || type === 'multi' ? 0 : 1,
      );
    },
  );

  it('allows composite choice identities repeated across definitions', () => {
    const row = {
      ...empty(),
      definitions: [definition('single', 'x'), definition('multi', 'y')],
    };
    expect(materialize(row).definitions).toHaveLength(2);
  });

  it.each([
    (r: ReturnType<typeof fixture>) => {
      r.definitions[0].type = 'unsupported';
    },
    (r: ReturnType<typeof fixture>) => {
      r.definitions[0].units[0].definitionId = 'wrong';
    },
    (r: ReturnType<typeof fixture>) => {
      r.families[0].bindings[0].familyId = 'wrong';
    },
    (r: ReturnType<typeof fixture>) => {
      r.families[0].bindings[0].definitionId = 'absent';
    },
    (r: ReturnType<typeof fixture>) => {
      r.families[0].bindings[0].definitionCode = 'wrong';
    },
    (r: ReturnType<typeof fixture>) => {
      r.families.push({ ...r.families[0], code: 'other' });
    },
    (r: ReturnType<typeof fixture>) => {
      r.families.push({ ...r.families[0], id: 'other' });
    },
    (r: ReturnType<typeof fixture>) => {
      r.definitions.push({ ...definition('text'), code: 'other' });
    },
    (r: ReturnType<typeof fixture>) => {
      r.definitions.push({ ...definition('text', 'other'), code: 'custom.d' });
    },
  ])(
    'delegates malformed leaves, parents, references and root duplicates %#',
    (change) => {
      const row = fixture();
      change(row);
      const before = JSON.stringify(row);
      freeze(row);
      rejects(row);
      expect(JSON.stringify(row)).toBe(before);
    },
  );

  it('preserves declared V1 with resolved metadata at this structural intermediate', () => {
    const row = fixture();
    Object.assign(row.definitions[0].numericPolicy!, {
      status: 'resolved',
      magnitude: 'custom',
      integer: false,
      lower: null,
      lowerInclusive: false,
      upper: null,
      upperInclusive: false,
    });
    const before = JSON.stringify(row);
    freeze(row);
    const output = materialize(row);
    expect(output.families[0]).not.toHaveProperty('minimumContractVersion');
    expect(output.definitions[0]).toMatchObject({
      numericPolicy: row.definitions[0].numericPolicy,
    });
    output.families[0].bindings[0].policy.route = 'pending';
    output.definitions[0].label = 'changed';
    expect(JSON.stringify(row)).toBe(before);
    expect(output.families[0].bindings[0].policy).not.toBe(
      row.families[0].bindings[0].policy,
    );
  });

  it.each(['family', 'scalar', 'choice', 'consistency'])(
    'preserves delegated %s sentinel identity',
    (stage) => {
      const sentinel = new Error(stage);
      const fail = () => {
        throw sentinel;
      };
      if (stage === 'family')
        jest
          .spyOn(family, 'materializeStoredFamilyV2')
          .mockImplementation(fail);
      if (stage === 'scalar')
        jest
          .spyOn(scalar, 'materializeStoredScalarDefinitionV2')
          .mockImplementation(fail);
      if (stage === 'choice')
        jest
          .spyOn(choice, 'materializeStoredChoiceDefinitionV2')
          .mockImplementation(fail);
      if (stage === 'consistency')
        jest
          .spyOn(consistency, 'validateVocabularyConsistencyV2')
          .mockImplementation(fail);
      const row = fixture();
      if (stage === 'choice') row.definitions = [definition('single')];
      expect(() => materialize(row)).toThrow(sentinel);
      try {
        materialize(row);
      } catch (error) {
        expect(error).toBe(sentinel);
      }
    },
  );
});
