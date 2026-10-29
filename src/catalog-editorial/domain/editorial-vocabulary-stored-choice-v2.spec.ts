import { materializeStoredChoiceDefinitionV2 as materialize } from './editorial-vocabulary-stored-choice-v2';
import * as choice from './editorial-vocabulary-choice-v2';

type Row = Record<string, unknown>;
function fixture(type = 'multi') {
  const parent = { definitionId: 'id', definitionType: type };
  return {
    id: 'id',
    code: 'animal',
    label: ' Animal ',
    type,
    numericPolicy: null,
    units: [],
    future: { nested: ['preserve raw'] },
    options: [
      { ...parent, code: 'b', label: 'Segundo', sortOrder: 9, archivedAt: '' },
      {
        ...parent,
        code: 'a',
        label: 'Primero',
        sortOrder: -2,
        archivedAt: null,
      },
    ],
    groups: [
      {
        ...parent,
        code: 'g',
        label: 'Grupo',
        members: [
          { definitionId: 'id', groupCode: 'g', optionCode: 'b' },
          { definitionId: 'id', groupCode: 'g', optionCode: 'a' },
        ],
      },
    ],
    aliases: ['café', 'CAFE'].map((label) => ({
      definitionId: 'id',
      label,
      optionCode: 'a',
    })),
  };
}
function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}
function reject(change: (row: ReturnType<typeof fixture>) => void) {
  const row = fixture();
  change(row);
  const before = structuredClone(row);
  expect(() => materialize(row)).toThrow(TypeError);
  expect(row).toEqual(before);
}

describe('stored choice V2 (dormant)', () => {
  it.each(['single', 'multi'])(
    'maps %s without ordering or spelling changes',
    (type) => {
      const row = fixture(type);
      const before = structuredClone(row);
      freeze(row);
      const result = materialize(row);
      expect(result).toEqual({
        id: 'id',
        code: 'animal',
        label: ' Animal ',
        type,
        options: [
          { code: 'b', label: 'Segundo', sortOrder: 9, archived: true },
          { code: 'a', label: 'Primero', sortOrder: -2, archived: false },
        ],
        groups: [{ code: 'g', label: 'Grupo', optionCodes: ['b', 'a'] }],
        aliases: [
          { label: 'café', optionCode: 'a' },
          { label: 'CAFE', optionCode: 'a' },
        ],
      });
      result.options[0].label = 'changed';
      result.groups[0].optionCodes.reverse();
      result.aliases[0].label = 'changed';
      expect(row).toEqual(before);
    },
  );

  it('accepts empty required choice branches', () => {
    const row = { ...fixture(), options: [], groups: [], aliases: [] };
    expect(materialize(row)).toEqual({
      id: row.id,
      code: row.code,
      label: row.label,
      type: row.type,
      options: [],
      groups: [],
      aliases: [],
    });
  });

  it('strips future storage columns and timestamps at every level', () => {
    const row = fixture();
    const extra = {
      createdAt: 'raw timestamp',
      future: { arbitrary: [null, 1] },
    };
    const expected = materialize(row);
    Object.assign(row, extra);
    [
      ...row.options,
      ...row.groups,
      ...row.groups[0].members,
      ...row.aliases,
    ].forEach((child) => Object.assign(child, extra));
    expect(materialize(row)).toEqual(expected);
  });

  it.each([null, '', '2026-01-01T00:00:00.000Z', 'not a date'])(
    'maps archivedAt %j by nullness alone',
    (archivedAt) => {
      const row = fixture();
      Object.assign(row.options[0], { archivedAt });
      expect(materialize(row).options[0].archived).toBe(archivedAt !== null);
    },
  );

  it.each([
    'id',
    'code',
    'label',
    'type',
    'numericPolicy',
    'units',
    'options',
    'groups',
    'aliases',
  ])('rejects missing required root %s', (key) =>
    reject((row) => {
      delete (row as Row)[key];
    }),
  );
  it.each(['units', 'options', 'groups', 'aliases'])(
    'rejects null branch %s',
    (key) =>
      reject((row) => {
        (row as Row)[key] = null;
      }),
  );
  it.each(['text', 'number', 'range', null, 1])(
    'rejects nonchoice type %j',
    (type) => reject((row) => Object.assign(row, { type })),
  );
  it.each([{}, { status: 'pending' }, false])(
    'rejects numeric metadata %j',
    (numericPolicy) => reject((row) => Object.assign(row, { numericPolicy })),
  );
  it('rejects populated units rather than dropping them', () =>
    reject((row) => Object.assign(row, { units: [{ unitCode: 'kg' }] })));

  it.each([
    [
      'option parent',
      (r) => {
        r.options[0].definitionId = 'other';
      },
    ],
    [
      'option type',
      (r) => {
        r.options[0].definitionType = 'single';
      },
    ],
    [
      'group parent',
      (r) => {
        r.groups[0].definitionId = 'other';
      },
    ],
    [
      'group type',
      (r) => {
        r.groups[0].definitionType = 'single';
      },
    ],
    [
      'member parent',
      (r) => {
        r.groups[0].members[0].definitionId = 'other';
      },
    ],
    [
      'member group',
      (r) => {
        r.groups[0].members[0].groupCode = 'other';
      },
    ],
    [
      'alias parent',
      (r) => {
        r.aliases[0].definitionId = 'other';
      },
    ],
    [
      'members not array',
      (r) => {
        Object.assign(r.groups[0], { members: {} });
      },
    ],
  ] satisfies [string, (r: ReturnType<typeof fixture>) => void][])(
    'rejects %s',
    (_name, change) => reject(change),
  );

  it.each(['options', 'groups', 'aliases'] as const)(
    'requires every wire field and parent on %s',
    (branch) => {
      const sample = fixture()[branch][0];
      for (const key of Object.keys(sample)) {
        reject((row) => {
          delete (row[branch][0] as Row)[key];
        });
      }
    },
  );
  it.each(['definitionId', 'groupCode', 'optionCode'])(
    'requires member %s',
    (key) =>
      reject((r) => {
        delete (r.groups[0].members[0] as Row)[key];
      }),
  );
  it.each([false, 0, {}, []])('rejects invalid archivedAt %j', (archivedAt) =>
    reject((r) => Object.assign(r.options[0], { archivedAt })),
  );

  it.each([
    [
      'duplicate option',
      (r) => {
        r.options.push({ ...r.options[0] });
      },
    ],
    [
      'duplicate group',
      (r) => {
        r.groups.push(structuredClone(r.groups[0]));
      },
    ],
    [
      'duplicate member',
      (r) => {
        r.groups[0].members.push({ ...r.groups[0].members[0] });
      },
    ],
    [
      'duplicate alias',
      (r) => {
        r.aliases.push({ ...r.aliases[0] });
      },
    ],
    [
      'dangling member',
      (r) => {
        r.groups[0].members[0].optionCode = 'absent';
      },
    ],
    [
      'dangling alias',
      (r) => {
        r.aliases[0].optionCode = 'absent';
      },
    ],
    [
      'Unicode collision',
      (r) => {
        r.aliases[1].optionCode = 'b';
      },
    ],
    [
      'blank definition label',
      (r) => {
        r.label = ' ';
      },
    ],
    [
      'blank option label',
      (r) => {
        r.options[0].label = '';
      },
    ],
    [
      'blank group label',
      (r) => {
        r.groups[0].label = '\t';
      },
    ],
    [
      'blank alias label',
      (r) => {
        r.aliases[0].label = ' ';
      },
    ],
    [
      'invalid sortOrder',
      (r) => {
        r.options[0].sortOrder = 0.5;
      },
    ],
  ] satisfies [string, (r: ReturnType<typeof fixture>) => void][])(
    'delegates %s rejection',
    (_name, change) => reject(change),
  );

  it.each([null, [], 'row', 3])('guards nonrecords %j', (row) => {
    expect(() => materialize(row)).toThrow(TypeError);
  });
  it('guards accessors before reading even future columns', () => {
    const getter = jest.fn(() => 'multi');
    const row = fixture();
    Object.defineProperty(row, 'type', { enumerable: true, get: getter });
    expect(() => materialize(row)).toThrow(TypeError);
    expect(getter).not.toHaveBeenCalled();
    Object.defineProperty(row, 'type', { value: 'multi' });
    Object.defineProperty(row, 'extra', { enumerable: true, get: getter });
    expect(() => materialize(row)).toThrow(TypeError);
    expect(getter).not.toHaveBeenCalled();
  });
  it('preserves the real unsupported Unicode runtime failure', () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      process.versions,
      'unicode',
    )!;
    try {
      Object.defineProperty(process.versions, 'unicode', {
        ...descriptor,
        value: '16.0',
      });
      expect(() => materialize(fixture())).toThrow(Error);
      expect(() => materialize(fixture())).not.toThrow(TypeError);
    } finally {
      Object.defineProperty(process.versions, 'unicode', descriptor);
    }
  });
  it.each(['cycle', 'date', 'undefined', 'nonfinite'])(
    'rejects non-JSON future data: %s',
    (kind) => {
      const row = fixture();
      const values: Row = {
        cycle: row,
        date: new Date(0),
        undefined: undefined,
        nonfinite: Infinity,
      };
      Object.assign(row, { extra: values[kind] });
      expect(() => materialize(row)).toThrow(TypeError);
    },
  );
  it('propagates validator errors by identity, including Unicode runtime errors', () => {
    const error = new Error('Unsupported Unicode runtime');
    const validator = jest
      .spyOn(choice, 'validateChoiceDefinitionV2')
      .mockImplementation(() => {
        throw error;
      });
    try {
      expect(() => materialize(fixture())).toThrow(error);
      try {
        materialize(fixture());
      } catch (actual) {
        expect(actual).toBe(error);
      }
    } finally {
      validator.mockRestore();
    }
  });
});
