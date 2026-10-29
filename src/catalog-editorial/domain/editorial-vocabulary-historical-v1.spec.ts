import { projectHistoricalVocabularyV1 as project } from './editorial-vocabulary-historical-v1';

const definition = (type = 'text', id = type) => ({
  id,
  code: id,
  label: '',
  type,
  units: [] as unknown[],
  options: [] as unknown[],
  numericPolicy: null as unknown,
});
const binding = (id: string, familyId = 'old') => ({
  familyId,
  definitionId: id,
  definitionCode: id,
  owner: 'sellable',
  sortOrder: -2,
  policy: null as unknown,
});
const family = (id: string, version: number, ids: string[]) => ({
  id,
  code: id,
  label: '',
  minimumContractVersion: version,
  bindings: ids.map((d) => binding(d, id)),
});
const unit = (id = '') => ({
  id,
  definitionId: 'number',
  definitionType: 'number',
  unitCode: null,
  label: null,
  sortOrder: -3,
});
const option = () => ({
  definitionId: 'single',
  definitionType: 'single',
  code: '',
  label: '',
  archivedAt: null as unknown,
  sortOrder: -4,
});
const resolved = () => ({
  status: 'resolved',
  magnitude: '\t',
  integer: true,
  lower: 10,
  upper: -10,
  lowerInclusive: true,
  upperInclusive: true,
  extra: 'preserved',
});
function fixture() {
  const definitions = ['text', 'boolean', 'number', 'single', 'multi'].map(
    (t) => definition(t),
  );
  definitions[2].units = [unit()];
  definitions[3].options = [option()];
  definitions[4].options = [
    {
      ...option(),
      definitionId: 'multi',
      definitionType: 'multi',
      archivedAt: '',
    },
  ];
  return {
    families: [
      family(
        'old',
        1,
        definitions.map((d) => d.id),
      ),
    ],
    definitions,
  };
}
function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}

describe('historical V1 composition', () => {
  it('keeps empty legacy families without requiring canonical production families', () => {
    expect(
      project({ families: [family('empty', 1, [])], definitions: [] }),
    ).toEqual({
      families: [{ id: 'empty', code: 'empty', label: '', bindings: [] }],
      definitions: [],
    });
  });
  it('copies all five types, exact legacy keys, blanks, nulls, order and archive presence', () => {
    const input = fixture();
    freeze(input);
    const output = project(input);
    expect(output).toEqual({
      families: [
        {
          id: 'old',
          code: 'old',
          label: '',
          bindings: input.families[0].bindings.map(
            ({ definitionId, definitionCode, owner, sortOrder }) => ({
              definitionId,
              definitionCode,
              owner,
              sortOrder,
            }),
          ),
        },
      ],
      definitions: [
        { id: 'text', code: 'text', label: '', type: 'text' },
        { id: 'boolean', code: 'boolean', label: '', type: 'boolean' },
        {
          id: 'number',
          code: 'number',
          label: '',
          type: 'number',
          units: [{ code: null, label: null, sortOrder: -3 }],
        },
        {
          id: 'single',
          code: 'single',
          label: '',
          type: 'single',
          options: [{ code: '', label: '', sortOrder: -4, archived: false }],
        },
        {
          id: 'multi',
          code: 'multi',
          label: '',
          type: 'multi',
          options: [{ code: '', label: '', sortOrder: -4, archived: true }],
        },
      ],
    });
    output.definitions[0].label = 'detached';
    output.families[0].bindings[0].sortOrder = 999;
    expect(input.definitions[0].label).toBe('');
    expect(input.families[0].bindings[0].sortOrder).toBe(-2);
  });

  it('indexes the complete graph: shared retained, omitted-only excluded, original unbound emitted', () => {
    const input = fixture();
    input.families.push(family('new', 2, ['text', 'orphan']));
    input.definitions.push(
      definition('number', 'orphan'),
      definition('text', 'unbound'),
      definition('range'),
    );
    input.definitions.at(-3)!.numericPolicy = { broken: true };
    input.definitions.at(-3)!.units = [false];
    input.families[1].bindings.forEach((b) => {
      b.policy = { anything: true };
    });
    const output = project(input);
    expect(output.families.map((f) => f.id)).toEqual(['old']);
    expect(output.definitions.map((d) => d.id)).toEqual([
      'text',
      'boolean',
      'number',
      'single',
      'multi',
      'unbound',
    ]);
    input.families[1].bindings[0].definitionId = 'missing';
    expect(() => project(input)).toThrow();
  });

  it.each([null, { route: 'pending' }])(
    'accepts retained binding policy %j',
    (policy) => {
      const input = fixture();
      input.families[0].bindings.forEach((b) => {
        b.policy = policy;
      });
      expect(project(input).families[0].bindings).toHaveLength(5);
    },
  );
  it.each([
    undefined,
    {},
    { route: 'pending', extra: 1 },
    { route: 'fact_rule' },
    { route: 'unknown' },
    false,
  ])('rejects whole call for binding policy %j', (policy) => {
    const input = fixture();
    if (policy === undefined)
      Reflect.deleteProperty(input.families[0].bindings[0], 'policy');
    else input.families[0].bindings[0].policy = policy;
    expect(() => project(input)).toThrow();
  });
  it.each([null, { status: 'pending' }])(
    'accepts numeric policy %j for retained and original unbound',
    (numericPolicy) => {
      const input = fixture();
      input.definitions[2].numericPolicy = numericPolicy;
      input.families = [];
      expect(project(input).definitions).toHaveLength(5);
      input.families = fixture().families;
      expect(project(input).definitions).toHaveLength(5);
    },
  );
  it.each([
    undefined,
    {},
    { status: 'pending', extra: 1 },
    false,
    { status: 'resolved' },
  ])(
    'rejects malformed numeric policy %j, never defaults missing',
    (policy) => {
      const input = fixture();
      if (policy === undefined)
        Reflect.deleteProperty(input.definitions[2], 'numericPolicy');
      else input.definitions[2].numericPolicy = policy;
      expect(() => project(input)).toThrow();
      input.families = [];
      expect(() => project(input)).toThrow();
    },
  );
  it('rejects retained range and resolved number contradictions without pruning or promotion', () => {
    const input = fixture();
    input.definitions[2].numericPolicy = resolved();
    expect(() => project(input)).toThrow();
    input.definitions[2].type = 'range';
    expect(() => project(input)).toThrow();
  });
  it('excludes storage-valid unbound resolved numbers without unit admission or strict V2 rules', () => {
    const input = fixture();
    input.families = [];
    input.definitions[2].numericPolicy = resolved();
    input.definitions[2].units = [false];
    expect(project(input).definitions.map((d) => d.id)).not.toContain('number');
    input.definitions[0].numericPolicy = { ignored: true };
    expect(project(input).definitions).toHaveLength(4);
  });
  it.each([
    'status',
    'magnitude',
    'integer',
    'lower',
    'upper',
    'lowerInclusive',
    'upperInclusive',
  ])('requires persisted resolved field %s', (key) => {
    const input = fixture();
    input.families = [];
    const policy: Record<string, unknown> = resolved();
    delete policy[key];
    input.definitions[2].numericPolicy = policy;
    expect(() => project(input)).toThrow();
  });
  it.each([
    ['magnitude', '   '],
    ['magnitude', null],
    ['integer', 1],
    ['lower', '0'],
    ['upper', false],
    ['lower', Infinity],
    ['upper', NaN],
    ['lowerInclusive', null],
    ['upperInclusive', 1],
  ])('rejects malformed persisted %s=%j', (key, value) => {
    const input = fixture();
    input.families = [];
    input.definitions[2].numericPolicy = {
      ...resolved(),
      [key]: value,
    };
    expect(() => project(input)).toThrow();
  });
  it('accepts inclusive-null persisted bounds for exclusion', () => {
    const input = fixture();
    input.families = [];
    input.definitions[2].numericPolicy = {
      ...resolved(),
      lower: null,
      upper: null,
    };
    expect(project(input).definitions).toHaveLength(4);
  });

  it.each([
    'id',
    'definitionId',
    'definitionType',
    'unitCode',
    'label',
    'sortOrder',
  ])('requires emitted unit field %s', (key) => {
    const input = fixture();
    const row = unit();
    Reflect.deleteProperty(row, key);
    input.definitions[2].units = [row];
    expect(() => project(input)).toThrow();
  });
  it.each([
    ['id', 1],
    ['definitionId', 'wrong'],
    ['definitionType', 'range'],
    ['unitCode', false],
    ['label', 1],
    ['sortOrder', 0.5],
  ])('rejects emitted unit %s=%j', (key, value) => {
    const input = fixture();
    input.definitions[2].units = [{ ...unit(), [key]: value }];
    expect(() => project(input)).toThrow();
  });
  it('rejects local duplicate codes (including null) and globally duplicate emitted unit IDs', () => {
    for (const code of [null, '']) {
      const input = fixture();
      input.definitions[2].units = [
        { ...unit('a'), unitCode: code },
        { ...unit('b'), unitCode: code },
      ];
      expect(() => project(input)).toThrow();
    }
    const input = fixture();
    input.definitions.push({
      ...definition('number', 'other'),
      units: [{ ...unit(), definitionId: 'other' }],
    });
    expect(() => project(input)).toThrow();
  });
  it.each([
    'definitionId',
    'definitionType',
    'code',
    'label',
    'sortOrder',
    'archivedAt',
  ])('requires emitted option field %s', (key) => {
    const input = fixture();
    const row = option();
    Reflect.deleteProperty(row, key);
    input.definitions[3].options = [row];
    expect(() => project(input)).toThrow();
  });
  it.each([
    ['definitionId', 'wrong'],
    ['definitionType', 'multi'],
    ['code', null],
    ['label', false],
    ['sortOrder', 0.5],
    ['archivedAt', true],
    ['archivedAt', 0],
    ['archivedAt', {}],
    ['archivedAt', new Date(0)],
  ])('rejects emitted option %s=%j', (key, value) => {
    const input = fixture();
    input.definitions[3].options = [{ ...option(), [key]: value }];
    expect(() => project(input)).toThrow();
  });
  it.each([null, '', 'not-a-date'])(
    'maps raw archivedAt %j by nullness only',
    (archivedAt) => {
      const input = fixture();
      input.definitions[3].options = [{ ...option(), archivedAt }];
      const output = project(input).definitions[3];
      expect(output.type === 'single' && output.options[0].archived).toBe(
        archivedAt !== null,
      );
    },
  );
  it('preserves independent nullable unit labels/codes and detached children', () => {
    const input = fixture();
    input.definitions[2].units = [
      { ...unit('a'), label: '' },
      { ...unit('b'), unitCode: '', label: null },
    ];
    freeze(input);
    const output = project(input);
    const number = output.definitions[2];
    if (number.type !== 'number') throw new Error('Expected number');
    expect(number.units.map((u) => [u.code, u.label])).toEqual([
      [null, ''],
      ['', null],
    ]);
    number.units[0].label = 'changed';
    const single = output.definitions[3];
    if (single.type !== 'single') throw new Error('Expected single');
    single.options[0].code = 'changed';
    expect(input.definitions[2].units[0]).toEqual({ ...unit('a'), label: '' });
    expect(input.definitions[3].options[0]).toEqual(option());
  });
  it('preserves a named unit and its submitted label', () => {
    const input = fixture();
    input.definitions[2].units = [
      { ...unit(), unitCode: ' kg ', label: ' Kilograms ' },
    ];
    const output = project(input).definitions[2];
    expect(output.type === 'number' && output.units[0]).toEqual({
      code: ' kg ',
      label: ' Kilograms ',
      sortOrder: -3,
    });
  });
  it('does not admit irrelevant metadata or original unbound advanced leaves', () => {
    const input = fixture();
    for (const index of [0, 1, 3, 4])
      input.definitions[index].numericPolicy = false;
    input.definitions.push({
      ...definition('range'),
      units: [false],
      numericPolicy: false,
    });
    expect(project(input).definitions).toHaveLength(5);
  });
  it('rejects duplicate option codes but not cross-definition codes', () => {
    const input = fixture();
    expect(project(input).definitions).toHaveLength(5);
    input.definitions[3].options.push(option());
    expect(() => project(input)).toThrow();
  });
});
