import { decodeHistoricalVocabularyGraph as decode } from './editorial-vocabulary-historical-graph';

const definition = (id = 'd', code = 'c', type = 'number') => ({
  id,
  code,
  type,
  label: '',
  units: [],
  options: [],
});
const binding = (familyId = 'f') => ({
  familyId,
  definitionId: 'd',
  definitionCode: 'c',
  owner: 'product',
  sortOrder: -1,
});
const family = (id = 'f', minimumContractVersion = 1) => ({
  id,
  code: id,
  label: '',
  minimumContractVersion,
  bindings: [binding(id)],
});
const fixture = () => ({ families: [family()], definitions: [definition()] });

describe('historical graph boundary', () => {
  it('accepts empty collections without metadata', () => {
    expect(decode({ families: [], definitions: [] })).toEqual({
      families: [],
      definitions: [],
    });
  });

  it.each(['text', 'boolean', 'number', 'single', 'multi', 'range'])(
    'retains %s without leaf admission',
    (type) => {
      const input = fixture();
      input.definitions[0].type = type;
      expect(decode(input).definitions[0].type).toBe(type);
    },
  );

  it('preserves exact blanks, Unicode identities, order and shared references', () => {
    const definitions = ['', 'é', 'e\u0301', ' x '].map((id) =>
      definition(id, id),
    );
    const families = ['', 'é', 'e\u0301'].map((id, index) => ({
      ...family(id, index === 1 ? 2 : 1),
      bindings: definitions.map((d, sortOrder) => ({
        ...binding(id),
        definitionId: d.id,
        definitionCode: d.code,
        sortOrder,
        owner: sortOrder % 2 ? 'sellable' : 'product',
      })),
    }));
    expect(decode({ families, definitions })).toEqual({
      families,
      definitions,
    });
  });

  it.each(['id', 'code'] as const)(
    'rejects duplicate family/definition %s independently',
    (key) => {
      const input = fixture();
      input.families.push({
        ...family('other'),
        [key]: input.families[0][key],
      });
      expect(() => decode(input)).toThrow();
      const other = fixture();
      other.definitions.push({
        ...definition('other', 'other'),
        [key]: other.definitions[0][key],
      });
      expect(() => decode(other)).toThrow();
    },
  );

  it.each([
    { familyId: 'wrong' },
    { definitionId: 'absent' },
    { definitionCode: 'wrong' },
    { owner: 'VARIANT' },
    { sortOrder: 1.5 },
    { sortOrder: Infinity },
    { definitionId: null },
    { definitionCode: null },
  ])('rejects every invalid binding even inside V2: %j', (patch) => {
    const input = fixture();
    input.families.push({
      ...family('omitted', 2),
      bindings: [{ ...binding('omitted'), ...patch }],
    } as never);
    expect(() => decode(input)).toThrow();
  });

  it.each(['definitionId', 'definitionCode'] as const)(
    'rejects local duplicate binding %s',
    (key) => {
      const input = fixture();
      input.definitions.push(definition('other', 'other'));
      input.families[0].bindings.push({
        ...binding(),
        definitionId: 'other',
        definitionCode: 'other',
        [key]: binding()[key],
      });
      expect(() => decode(input)).toThrow();
    },
  );

  it.each([
    null,
    [],
    {},
    { families: [], definitions: null },
    { families: [null], definitions: [] },
    { families: [{ ...family(), bindings: null }], definitions: [] },
    { families: [], definitions: [{ ...definition(), type: 'future' }] },
    { families: [family('f', 3)], definitions: [definition()] },
    { families: [], definitions: [{ ...definition(), label: null }] },
    { families: [], definitions: [{ ...definition(), units: null }] },
    { families: [], definitions: [{ ...definition(), options: {} }] },
  ])('rejects malformed graph structure %j', (input) => {
    expect(() => decode(input)).toThrow();
  });

  it.each(['familyId', 'definitionId', 'definitionCode', 'owner', 'sortOrder'])(
    'requires binding %s',
    (key) => {
      const input = fixture();
      Reflect.deleteProperty(input.families[0].bindings[0], key);
      expect(() => decode(input)).toThrow();
    },
  );

  it.each([
    null,
    { route: 'pending' },
    { status: 'resolved', lower: null },
    { future: [null, ''] },
  ])('detaches raw policy without classifying %j', (raw) => {
    const input = fixture();
    const enriched = {
      families: [
        { ...input.families[0], bindings: [{ ...binding(), policy: raw }] },
      ],
      definitions: [{ ...definition(), numericPolicy: raw }],
    };
    const output = decode(enriched);
    expect(output.families[0].bindings[0].policy).toEqual(raw);
    expect(output.definitions[0].numericPolicy).toEqual(raw);
    if (raw !== null) expect(output.definitions[0].numericPolicy).not.toBe(raw);
    expect(decode(input).definitions[0]).not.toHaveProperty('numericPolicy');
    expect(decode(input).families[0].bindings[0]).not.toHaveProperty('policy');
  });

  it('retains detached untrusted malformed leaves, omits future columns and never mutates frozen input', () => {
    const unit = Object.freeze({
      unitCode: { bad: ['raw'] },
      archivedAt: null,
      future: 'secret-column',
    });
    const input = Object.freeze({
      metadata: new Date(),
      families: Object.freeze([
        Object.freeze({
          ...family(),
          bindings: Object.freeze([Object.freeze(binding())]),
          exposure: 'future',
        }),
      ]),
      definitions: Object.freeze([
        Object.freeze({
          ...definition(),
          units: Object.freeze([unit]),
          options: Object.freeze([
            null,
            { archivedAt: { malformed: true }, future: 1 },
          ]),
          groups: new Date(),
          aliases: undefined,
        }),
      ]),
    });
    const output = decode(input);
    expect(output.definitions[0].units).toEqual([
      { unitCode: { bad: ['raw'] } },
    ]);
    expect(output.definitions[0].options).toEqual([
      null,
      { archivedAt: { malformed: true } },
    ]);
    expect(output.definitions[0].units).not.toBe(input.definitions[0].units);
    expect(output).not.toHaveProperty('metadata');
    expect(output.families[0]).not.toHaveProperty('exposure');
    expect(output.definitions[0]).not.toHaveProperty('groups');
    (
      output.definitions[0].units as { unitCode: { bad: string[] } }[]
    )[0].unitCode.bad.push('changed');
    expect(unit.unitCode.bad).toEqual(['raw']);
  });

  it('guards accessors before reading and ignores discarded fields without invoking them', () => {
    const getter = jest.fn(() => 'd');
    const input = fixture();
    Object.defineProperty(input.definitions[0], 'id', { get: getter });
    expect(() => decode(input)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    const safe = fixture();
    Object.defineProperty(safe, 'metadata', { get: getter });
    expect(() => decode(safe)).not.toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    NaN,
    new Date(),
    () => 1,
    Object.create({ inherited: 1 }) as unknown,
  ])('rejects non-JSON retained raw data', (policy) => {
    const input = fixture();
    expect(() =>
      decode({
        ...input,
        definitions: [{ ...definition(), numericPolicy: policy }],
      }),
    ).toThrow();
  });

  it('rejects sparse/accessor arrays and cycles without executing accessors', () => {
    const getter = jest.fn();
    const families = [family()];
    Object.defineProperty(families, '0', { get: getter });
    expect(() => decode({ families, definitions: [] })).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(() => decode({ families: new Array(1), definitions: [] })).toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      decode({
        families: [],
        definitions: [{ ...definition(), numericPolicy: cyclic }],
      }),
    ).toThrow();
  });

  it('propagates introspection errors unchanged', () => {
    const error = new Error('introspection failure');
    const input = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw error;
        },
      },
    );
    expect(() => decode(input)).toThrow(error);
  });
});
