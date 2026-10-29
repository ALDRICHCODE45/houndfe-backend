import { materializeStoredScalarDefinitionV2 as materialize } from './editorial-vocabulary-stored-scalar-v2';
import * as simple from './editorial-vocabulary-simple-v2';
import * as numeric from './editorial-vocabulary-numeric-v2';

const resolved = {
  status: 'resolved',
  magnitude: '  temperatura °C  ',
  integer: false,
  lower: -20,
  lowerInclusive: true,
  upper: null,
  upperInclusive: false,
};
function unit(type = 'number', id = 'u1', code: string | null = 'kg') {
  return {
    id,
    definitionId: ' d ',
    definitionType: type,
    unitCode: code,
    label: code === null ? null : '  Kilógramos 🐾  ',
    sortOrder: -3,
    future: { preservedInStorage: true },
  };
}
function stored(type = 'number'): Record<string, unknown> {
  return {
    id: ' d ',
    code: '  custom.é  ',
    label: '  Texto\n🐾  ',
    type,
    numericPolicy: ['text', 'boolean'].includes(type)
      ? null
      : { status: 'pending' },
    units: ['text', 'boolean'].includes(type) ? [] : [unit(type)],
    options: [],
    groups: [],
    aliases: [],
    future: { column: ['not wire metadata'] },
  };
}
function wire(d: Record<string, unknown>) {
  return { id: d.id, code: d.code, label: d.label, type: d.type };
}
function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}

describe('stored scalar V2 materialization (dormant)', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each(['text', 'boolean'])('copies only %s wire fields', (type) => {
    const d = stored(type);
    freeze(d);
    const result = materialize(d);
    expect(result).toEqual(wire(d));
    expect(result).not.toBe(d);
  });

  it.each(['number', 'range'])(
    'preserves %s pending/resolved metadata and order',
    (type) => {
      for (const numericPolicy of [{ status: 'pending' }, resolved]) {
        const units = [unit(type, '', 'z'), unit(type, 'other', 'a')];
        units[0].sortOrder = 8;
        const d = { ...stored(type), numericPolicy, units };
        const before = structuredClone(d);
        freeze(d);
        const result = materialize(d);
        expect(result).toEqual({
          ...wire(d),
          numericPolicy,
          units: units.map((u) => ({
            code: u.unitCode,
            label: u.label,
            sortOrder: u.sortOrder,
          })),
        });
        if (!('units' in result)) throw new Error('Expected numeric output');
        expect(result.units).not.toBe(units);
        expect(result.units[0]).not.toBe(units[0]);
        expect(result.numericPolicy).not.toBe(numericPolicy);
        result.units[0].label = 'changed';
        result.numericPolicy.status = 'pending';
        expect(d).toEqual(before);
      }
    },
  );

  it('preserves a number null unit and allows empty numeric unit lists', () => {
    const d = { ...stored(), units: [unit('number', '', null)] };
    expect(materialize(d)).toEqual({
      ...wire(d),
      numericPolicy: { status: 'pending' },
      units: [{ code: null, label: null, sortOrder: -3 }],
    });
    expect(materialize({ ...d, units: [] })).toHaveProperty('units', []);
  });

  it.each(['text', 'boolean', 'number', 'range'])(
    'requires every raw child array for %s',
    (type) => {
      for (const key of ['units', 'options', 'groups', 'aliases']) {
        const missing = stored(type);
        delete missing[key];
        expect(() => materialize(missing)).toThrow(TypeError);
        for (const value of [null, {}, 'array']) {
          expect(() => materialize({ ...stored(type), [key]: value })).toThrow(
            TypeError,
          );
        }
      }
    },
  );

  it.each(['text', 'boolean', 'number', 'range'])(
    'rejects incompatible populated branches for %s',
    (type) => {
      for (const key of [
        'options',
        'groups',
        'aliases',
        ...(['text', 'boolean'].includes(type) ? ['units'] : []),
      ]) {
        expect(() => materialize({ ...stored(type), [key]: [{}] })).toThrow(
          TypeError,
        );
      }
    },
  );

  it.each(['text', 'boolean'])(
    'requires explicit null numeric policy for %s',
    (type) => {
      const d = stored(type);
      delete d.numericPolicy;
      expect(() => materialize(d)).toThrow(TypeError);
      for (const numericPolicy of [{ status: 'pending' }, {}, false]) {
        expect(() => materialize({ ...stored(type), numericPolicy })).toThrow(
          TypeError,
        );
      }
    },
  );

  it.each(['single', 'multi', 'Number', '', null, 3])(
    'rejects unsupported type %p',
    (type) => {
      expect(() => materialize({ ...stored(), type })).toThrow(TypeError);
    },
  );

  it.each(['text', 'number'])(
    'delegates required identity fields for %s',
    (type) => {
      for (const key of ['id', 'code', 'label', 'type']) {
        const d = stored(type);
        delete d[key];
        expect(() => materialize(d)).toThrow(TypeError);
        for (const value of [null, 1, '']) {
          expect(() => materialize({ ...stored(type), [key]: value })).toThrow(
            TypeError,
          );
        }
      }
    },
  );

  it.each(['number', 'range'])(
    'checks exact stored unit identity and parents for %s',
    (type) => {
      for (const key of ['id', 'definitionId', 'definitionType']) {
        const u: Record<string, unknown> = unit(type);
        delete u[key];
        expect(() => materialize({ ...stored(type), units: [u] })).toThrow(
          TypeError,
        );
        for (const value of [null, 5, ...(key === 'id' ? [] : ['wrong', ''])]) {
          expect(() =>
            materialize({
              ...stored(type),
              units: [{ ...unit(type), [key]: value }],
            }),
          ).toThrow(TypeError);
        }
      }
      for (const value of [null, [], 'unit']) {
        expect(() => materialize({ ...stored(type), units: [value] })).toThrow(
          TypeError,
        );
      }
      expect(() =>
        materialize({
          ...stored(type),
          units: [unit(type), unit(type, 'u1', 'g')],
        }),
      ).toThrow(TypeError);
      expect(() =>
        materialize({ ...stored(type), units: [unit(type), unit(type, 'u2')] }),
      ).toThrow(TypeError);
    },
  );

  it.each(['number', 'range'])(
    'does not invent or prune %s numeric policies',
    (type) => {
      const d = stored(type);
      delete d.numericPolicy;
      expect(() => materialize(d)).toThrow(TypeError);
      for (const numericPolicy of [
        null,
        {},
        [],
        'pending',
        { status: 'pending', extra: true },
        { ...resolved, extra: true },
        { ...resolved, lower: 10, upper: 2 },
        { ...resolved, lower: null },
        { status: 'resolved' },
      ]) {
        expect(() => materialize({ ...stored(type), numericPolicy })).toThrow(
          TypeError,
        );
      }
    },
  );

  it('delegates representative unit constraints without repairing them', () => {
    for (const patch of [
      { unitCode: null },
      { label: null },
      { label: '' },
      { unitCode: '' },
      { sortOrder: 0.5 },
      { sortOrder: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(() =>
        materialize({ ...stored(), units: [{ ...unit(), ...patch }] }),
      ).toThrow(TypeError);
    }
    expect(() =>
      materialize({ ...stored('range'), units: [unit('range', 'u', null)] }),
    ).toThrow(TypeError);
  });

  it.each(['text', 'number'])(
    'preserves validator error identity for %s',
    (type) => {
      const sentinel = new Error('validator sentinel');
      const spy =
        type === 'text'
          ? jest.spyOn(simple, 'validateSimpleDefinitionV2')
          : jest.spyOn(numeric, 'validateNumericDefinitionV2');
      spy.mockImplementation(() => {
        throw sentinel;
      });
      expect(() => materialize(stored(type))).toThrow(sentinel);
      try {
        materialize(stored(type));
      } catch (error) {
        expect(error).toBe(sentinel);
      }
    },
  );

  it('passes the entire numeric policy unchanged to the validator', () => {
    const numericPolicy = { ...resolved, extra: true };
    const spy = jest.spyOn(numeric, 'validateNumericDefinitionV2');
    expect(() => materialize({ ...stored(), numericPolicy })).toThrow(
      TypeError,
    );
    expect(spy.mock.calls[0][0]).toHaveProperty('numericPolicy', numericPolicy);
    expect(
      (spy.mock.calls[0][0] as Record<string, unknown>).numericPolicy,
    ).toBe(numericPolicy);
  });

  it('guards accessors throughout raw rows before property access', () => {
    const getter = jest.fn(() => 'number');
    for (const location of ['root', 'unit', 'future']) {
      const d = stored();
      const accessor = Object.defineProperty({}, 'type', {
        enumerable: true,
        get: getter,
      });
      if (location === 'root')
        Object.defineProperty(d, 'type', { enumerable: true, get: getter });
      else
        d[location === 'unit' ? 'units' : 'future'] =
          location === 'unit' ? [accessor] : accessor;
      expect(() => materialize(d)).toThrow(TypeError);
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    null,
    [],
    1,
    new Date(),
    { ...stored(), future: NaN },
    { ...stored(), future: undefined },
    { ...stored(), future: () => 1 },
  ])('rejects non-JSON input %p', (input) => {
    expect(() => materialize(input)).toThrow(TypeError);
  });
});
