import { Buffer } from 'node:buffer';
import {
  CanonicalEditorialJsonError,
  canonicalEditorialJson,
  hashEditorialJson,
} from './editorial-canonical-json';

const invalid = 'Expected a finite, acyclic JSON data tree';

const encoders = [canonicalEditorialJson, hashEditorialJson];

describe.each(encoders)('%p error boundary', (serialize) => {
  it.each([
    ['invalid scalar', NaN],
    ['nested invalid tree', { nested: [undefined] }],
  ])('classifies %s while retaining the TypeError contract', (_, value) => {
    let caught: unknown;
    try {
      serialize(value);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CanonicalEditorialJsonError);
    expect(caught).toBeInstanceOf(TypeError);
    expect(caught).toHaveProperty('name', 'TypeError');
    expect(caught).toHaveProperty('message', invalid);
  });

  it.each([
    ['Error', new Error('unexpected reflection failure')],
    ['TypeError', new TypeError(invalid)],
    ['RangeError', new RangeError('unexpected reflection failure')],
    ['non-Error sentinel', Object.freeze({ unexpected: true })],
  ])(
    'propagates unexpected %s by identity without classification',
    (_, sentinel) => {
      const getter = jest.fn(() => 1);
      const target = Object.defineProperty({}, 'value', {
        enumerable: true,
        get: getter,
      });
      const input = new Proxy(target, {
        ownKeys() {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- public reflection may throw any value
          throw sentinel;
        },
      });
      let caught: unknown;
      try {
        serialize(input);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(sentinel);
      expect(caught).not.toBeInstanceOf(CanonicalEditorialJsonError);
      expect(getter).not.toHaveBeenCalled();
    },
  );
});
// Literal preimages were independently hashed with Python hashlib.sha256, not
// generated with the implementation under test. Keep these digest constants.
const vectors: [unknown, string, string][] = [
  [
    { a: [null, true, false], '2': 'two', '10': 'ten' },
    '{"10":"ten","2":"two","a":[null,true,false]}',
    '92e5c30c160027465056955852e554aa32b35fc450268d07584c2280a9d69799',
  ],
  [
    { '😀': 'supplementary', '\ue000': 'bmp' },
    '{"\ue000":"bmp","😀":"supplementary"}',
    'd7dce2425300ac0417387858fba9ab9ef4378796354c9469378ff1cdb09b3851',
  ],
  [
    [null, true, false, -0, 1e21, 1e-6, 1e-7],
    '[null,true,false,0,1e+21,0.000001,1e-7]',
    'f132c861bf758035f4a53f4f67f2a460c117f26af04e64c9bed89e5f17a79249',
  ],
];

it.each(vectors)(
  'emits exact bytes and a literal SHA-256 vector %#',
  (value, bytes, digest) => {
    expect(canonicalEditorialJson(value)).toEqual(Buffer.from(bytes, 'utf8'));
    expect(hashEditorialJson(value)).toBe(digest);
  },
);

it('escapes every C0 character with lowercase hex, never shorthand', () => {
  const controls = String.fromCharCode(
    ...Array.from({ length: 32 }, (_, i) => i),
  );
  const expected =
    '"' +
    String.raw`\u0000\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0008\u0009\u000a\u000b\u000c\u000d\u000e\u000f\u0010\u0011\u0012\u0013\u0014\u0015\u0016\u0017\u0018\u0019\u001a\u001b\u001c\u001d\u001e\u001f` +
    '"';
  expect(canonicalEditorialJson(controls)).toEqual(Buffer.from(expected));
  expect(canonicalEditorialJson({ [controls]: controls })).toEqual(
    Buffer.from('{' + expected + ':' + expected + '}'),
  );
});

it('escapes quote/backslash, leaves slash and Unicode literal, without normalization', () => {
  const value = '"\\/é e\u0301 😀\u2028\u2029';
  const expected = '"' + String.raw`\"\\/` + 'é e\u0301 😀\u2028\u2029' + '"';
  expect(canonicalEditorialJson(value)).toEqual(Buffer.from(expected, 'utf8'));
  expect(hashEditorialJson('é')).not.toBe(hashEditorialJson('e\u0301'));
});

it('sorts nested keys but preserves arrays, nulls and empty containers', () => {
  const value = Object.freeze({
    z: Object.freeze([{ b: 2, a: 1 }, null, [], {}]),
    a: false,
  });
  expect(canonicalEditorialJson(value).toString()).toBe(
    '{"a":false,"z":[{"a":1,"b":2},null,[],{}]}',
  );
  expect(hashEditorialJson({ z: value.z, a: false })).toBe(
    hashEditorialJson({ a: false, z: value.z }),
  );
  expect(hashEditorialJson([1, 2])).not.toBe(hashEditorialJson([2, 1]));
  expect(Object.keys(value)).toEqual(['z', 'a']);
  expect(Object.keys(value.z[0]!)).toEqual(['b', 'a']);
});

it.each(['\ud800', '\udfff', 'x\ud800z', '\udc00\ud800'])(
  'rejects lone surrogates in values and keys %#',
  (value) => {
    expect(() => canonicalEditorialJson(value)).toThrow(new TypeError(invalid));
    expect(() => canonicalEditorialJson({ [value]: 1 })).toThrow(
      new TypeError(invalid),
    );
  },
);

it.each([undefined, NaN, Infinity, -Infinity, BigInt(1), Symbol('x'), () => 1])(
  'rejects non-JSON primitives at every depth %#',
  (value) => {
    for (const input of [value, [value], { nested: value }]) {
      expect(() => canonicalEditorialJson(input)).toThrow(
        new TypeError(invalid),
      );
      expect(() => hashEditorialJson(input)).toThrow(new TypeError(invalid));
    }
  },
);

it('rejects cycles, not repeated references, and returns fresh bytes', () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  expect(() => canonicalEditorialJson(cycle)).toThrow(new TypeError(invalid));
  const shared = Object.freeze({ value: 1 });
  expect(canonicalEditorialJson([shared, shared]).toString()).toBe(
    '[{"value":1},{"value":1}]',
  );
  const bytes = canonicalEditorialJson(shared);
  bytes.fill(0);
  expect(canonicalEditorialJson(shared).toString()).toBe('{"value":1}');
});

it('rejects non-data objects, accessors and hidden properties without invoking them', () => {
  const getter = jest.fn(() => 1);
  const accessor = Object.defineProperty({}, 'value', {
    get: getter,
    enumerable: true,
  });
  const hidden = Object.defineProperty({}, 'hidden', { value: 1 });
  const symbol = { [Symbol('hidden')]: 1 };
  for (const value of [
    new Date(0),
    new Map(),
    new Set(),
    accessor,
    hidden,
    symbol,
  ]) {
    expect(() => canonicalEditorialJson(value)).toThrow(new TypeError(invalid));
  }
  expect(getter).not.toHaveBeenCalled();
  const plain: unknown = Object.assign(Object.create(null), { a: 1 });
  expect(canonicalEditorialJson(plain).toString()).toBe('{"a":1}');
});

it('rejects sparse or decorated arrays instead of losing data', () => {
  const sparse = new Array(1);
  const decorated = Object.assign([1], { extra: 2 });
  const getter = jest.fn(() => 1);
  const accessor = Object.defineProperty([1], '0', { get: getter });
  for (const value of [sparse, decorated, accessor]) {
    expect(() => canonicalEditorialJson(value)).toThrow(new TypeError(invalid));
  }
  expect(getter).not.toHaveBeenCalled();
});
