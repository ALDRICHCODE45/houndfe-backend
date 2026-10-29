import { parseCareCaptureShapeV2 as parse } from './editorial-care-capture-shape-v2';

const evidence = () => ({ sourceRef: '\ud800', verifiedOn: 'not a date' });
const requirement = () => ({
  key: '',
  description: '',
  disposition: 'conflicting',
  evidence: [evidence()],
  basis: '',
});
const warning = () => ({
  key: '',
  requirementKeys: ['missing', 'missing'],
  text: '',
  disclosure: 'public_required',
  evidence: [evidence()],
  handlingBasis: '',
});
const prepared = () => ({
  state: 'prepared',
  jurisdiction: '',
  intendedUse: '\ud800',
  determination: 'none_applicable',
  evidence: [evidence(), evidence()],
  basis: '',
  requirements: [requirement(), requirement()],
  warnings: [warning(), warning()],
});
const message = 'Expected a care capture shape V2';
function rejects(input: unknown, expected = message) {
  expect(() => parse(input)).toThrow(new TypeError(expected));
}
function freeze(input: unknown) {
  if (input && typeof input === 'object') {
    Object.values(input).forEach(freeze);
    Object.freeze(input);
  }
}
function detached(source: unknown, result: unknown) {
  expect(result).toEqual(source);
  if (source && typeof source === 'object') {
    expect(result).not.toBe(source);
    for (const key of Object.keys(source)) {
      detached(
        (source as Record<string, unknown>)[key],
        (result as Record<string, unknown>)[key],
      );
    }
  }
}

describe('parseCareCaptureShapeV2', () => {
  it.each(['identified', 'none_applicable'])(
    'preserves %s capture only',
    (determination) => {
      const source = { ...prepared(), determination };
      freeze(source);
      const result = parse(source);
      detached(source, result);
      if (result.state !== 'prepared') throw new Error('prepared expected');
      result.evidence[0].sourceRef = 'changed';
      result.requirements[0].evidence.push(evidence());
      result.warnings[0].requirementKeys.push('changed');
      result.warnings[0].evidence[0].verifiedOn = 'changed';
      expect(source).toEqual({ ...prepared(), determination });
    },
  );

  it('preserves distinct input ordering alongside duplicate entries', () => {
    const source = prepared();
    source.evidence[0].sourceRef = 'z';
    source.requirements[0].key = 'z';
    source.warnings[0].key = 'z';
    source.evidence.push(evidence());
    source.requirements.push(requirement());
    source.warnings.push(warning());
    detached(source, parse(source));
  });

  it('returns a detached closed unknown without defaults', () => {
    const source = Object.freeze({ state: 'unknown' });
    detached(source, parse(source));
    expect(Object.keys(parse(source))).toEqual(['state']);
  });

  it('preserves empty prepared arrays and unresolved entries', () => {
    const source = {
      ...prepared(),
      evidence: [],
      requirements: [],
      warnings: [],
    };
    detached(source, parse(source));
    const alternate = prepared();
    alternate.requirements[0].disposition = 'unresolved';
    alternate.warnings[0].disclosure = 'unresolved';
    expect(parse(alternate)).toEqual(alternate);
  });

  it.each([
    null,
    undefined,
    true,
    1,
    'prepared',
    [],
    new Date(0),
    { state: 'ready' },
  ])('rejects root %p', (input) => rejects(input));

  it.each(Object.keys(prepared()))('requires prepared key %s', (key) => {
    const input: Record<string, unknown> = prepared();
    delete input[key];
    rejects(input);
  });

  it.each(['jurisdiction', 'intendedUse', 'basis', 'determination', 'state'])(
    'rejects nonprimitive/invalid %s',
    (key) => {
      for (const value of [null, 1, new String('identified'), 'invalid']) {
        if (
          value === 'invalid' &&
          ['jurisdiction', 'intendedUse', 'basis'].includes(key)
        )
          continue;
        rejects({ ...prepared(), [key]: value });
      }
    },
  );

  it('rejects unknown omissions/extras and prepared extras', () => {
    rejects({});
    rejects({ state: 'unknown', evidence: [] });
    rejects({ state: 'unknown', ...{ jurisdiction: '' } });
    rejects({ ...prepared(), actorId: 'client' });
  });

  it.each(['evidence', 'requirements', 'warnings'])(
    'checks %s arrays and leaf errors',
    (key) => {
      for (const value of [null, {}, 'array'])
        rejects({ ...prepared(), [key]: value });
      const leafMessage =
        key === 'evidence'
          ? 'Expected an evidence shape V2'
          : 'Expected a care entry shape V2';
      rejects({ ...prepared(), [key]: [null] }, leafMessage);
    },
  );

  it.each(['evidence', 'requirements', 'warnings'])(
    'rejects non-data %s arrays without getters',
    (key) => {
      const getter = jest.fn(() => evidence());
      const accessor = Object.defineProperty([evidence()], '0', {
        get: getter,
      });
      const hidden = Object.defineProperty([evidence()], '0', {
        enumerable: false,
      });
      const decorated = Object.assign([], { extra: true });
      const symbol = Object.assign([], { [Symbol('extra')]: true });
      const hiddenExtra = Object.defineProperty([], 'extra', { value: true });
      const exotic: unknown[] = [];
      Object.setPrototypeOf(exotic, null);
      for (const value of [
        accessor,
        hidden,
        decorated,
        symbol,
        hiddenExtra,
        exotic,
        new Array(1),
      ]) {
        rejects({ ...prepared(), [key]: value });
      }
      expect(getter).not.toHaveBeenCalled();
    },
  );

  it('rejects root accessors, hidden/symbol fields and exotic prototypes', () => {
    const getter = jest.fn(() => 'unknown');
    rejects(
      Object.defineProperty({}, 'state', { enumerable: true, get: getter }),
    );
    rejects(
      Object.defineProperty({ state: 'unknown' }, 'state', {
        enumerable: false,
      }),
    );
    rejects({ state: 'unknown', [Symbol('extra')]: true });
    rejects(
      Object.defineProperty({ state: 'unknown' }, 'extra', { value: true }),
    );
    rejects(Object.create({ state: 'unknown' }));
    rejects(Object.assign(Object.create({}), prepared()));
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(['evidence', 'requirements', 'warnings'])(
    'does not execute nested %s getters',
    (key) => {
      const getter = jest.fn(() => 'value');
      const item =
        key === 'evidence'
          ? evidence()
          : key === 'requirements'
            ? requirement()
            : warning();
      Object.defineProperty(item, Object.keys(item)[0], {
        enumerable: true,
        get: getter,
      });
      rejects(
        { ...prepared(), [key]: [item] },
        key === 'evidence'
          ? 'Expected an evidence shape V2'
          : 'Expected a care entry shape V2',
      );
      expect(getter).not.toHaveBeenCalled();
    },
  );

  it('accepts null-prototype records throughout the capture', () => {
    const convert = (input: unknown): unknown => {
      if (Array.isArray(input)) return input.map(convert);
      if (!input || typeof input !== 'object') return input;
      return Object.assign(
        Object.create(null),
        Object.fromEntries(
          Object.entries(input).map(([key, value]) => [key, convert(value)]),
        ),
      );
    };
    expect(parse(convert(prepared()))).toEqual(prepared());
    expect(parse(convert({ state: 'unknown' }))).toEqual({ state: 'unknown' });
  });

  it.each([new Error('reflection'), new TypeError(message), 'non-error'])(
    'propagates reflection failure identity %p',
    (sentinel) => {
      for (const trap of [
        'getPrototypeOf',
        'ownKeys',
        'getOwnPropertyDescriptor',
      ]) {
        const proxy = (target: object) =>
          new Proxy(target, {
            [trap]: () => {
              // eslint-disable-next-line @typescript-eslint/only-throw-error -- verify non-Error identity too
              throw sentinel;
            },
          });
        const inputs = [
          proxy(prepared()),
          { ...prepared(), evidence: proxy([]) },
          { ...prepared(), requirements: proxy([]) },
          { ...prepared(), warnings: proxy([]) },
          { ...prepared(), evidence: [proxy(evidence())] },
          { ...prepared(), requirements: [proxy(requirement())] },
          { ...prepared(), warnings: [proxy(warning())] },
        ];
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
