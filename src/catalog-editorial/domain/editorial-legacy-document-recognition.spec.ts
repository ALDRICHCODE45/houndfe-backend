import { emptyDocument, EditorialDocument, EditorialValue } from './document';
import { isRecognizableLegacyDocument as recognizes } from './editorial-legacy-document-recognition';

const text = (): EditorialValue => ({
  code: '',
  owner: 'product',
  variantId: null,
  type: 'text',
  value: '\ud800',
});
const document = (values: unknown[] = []): Record<string, unknown> => ({
  ...emptyDocument(),
  familyCode: 'unknown',
  values,
});
const value = (changes: Record<string, unknown> = {}) => ({
  ...text(),
  ...changes,
});

function freeze(input: unknown): void {
  if (input && typeof input === 'object') {
    Object.values(input).forEach(freeze);
    Object.freeze(input);
  }
}

describe('legacy structural adoption recognition (S2, contract §5)', () => {
  it('recognizes emptyDocument but not legacy-mode history {}', () => {
    expect(recognizes(emptyDocument())).toBe(true);
    expect(recognizes({})).toBe(false);
  });

  it('preserves all five branches, unknown memberships, exact strings and order', () => {
    const input = document([
      text(),
      value({ code: 'bool', type: 'boolean', value: false }),
      value({ code: 'num', type: 'number', value: -0.5, unit: null }),
      value({ code: 'single', owner: 'sellable', type: 'single', value: '' }),
      value({
        code: 'multi',
        owner: 'sellable',
        variantId: 'missing',
        type: 'multi',
        value: ['z', '', '\udfff'],
      }),
      value({ code: 'zero', type: 'number', value: 0, unit: 'missing' }),
    ]);
    input.commercialTitle = '  \ud800';
    input.description = 'x'.repeat(100_000);
    input.mediaRefs = Array.from({ length: 1001 }, (_, i) => `missing-${i}`);
    const before = JSON.stringify(input);
    const values = input.values;
    freeze(input);
    expect(recognizes(input)).toBe(true);
    expect(input.values).toBe(values);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('accepts null prototypes and distinguishes collision-prone tuple strings', () => {
    const input = Object.assign(
      Object.create(null) as EditorialDocument,
      document([
        value({ code: 'a|b', owner: 'sellable', variantId: 'c' }),
        value({ code: 'a', owner: 'sellable', variantId: 'b|c' }),
      ]),
    );
    Object.setPrototypeOf(input.values[0], null);
    expect(recognizes(input)).toBe(true);
  });

  it.each([
    null,
    undefined,
    false,
    1,
    'text',
    [],
    new Date(),
    Object.create({}) as unknown,
  ])('rejects non-document data %#', (input) =>
    expect(recognizes(input)).toBe(false),
  );

  it.each([
    'commercialTitle',
    'description',
    'mediaRefs',
    'familyCode',
    'values',
  ])('requires root field %s', (key) => {
    const input = document();
    delete input[key];
    expect(recognizes(input)).toBe(false);
  });

  it.each([
    { commercialTitle: 3 },
    { description: false },
    { mediaRefs: ['x', 'x'] },
    { mediaRefs: [null] },
    { familyCode: 0 },
    { values: null },
    { extra: null },
    { schemaVersion: 2 },
  ])('rejects malformed root %#', (change) => {
    expect(recognizes({ ...document(), ...change })).toBe(false);
  });

  it.each(['code', 'owner', 'variantId', 'type', 'value'])(
    'requires value field %s',
    (key) => {
      const input = value();
      delete input[key];
      expect(recognizes(document([input]))).toBe(false);
    },
  );

  it.each([
    { code: null },
    { owner: 'variant' },
    { variantId: 1 },
    { variantId: 'v' },
    { type: 'range' },
    { value: null },
    { type: 'boolean', value: 'false' },
    { type: 'single', value: [] },
    { type: 'number', value: 1 },
    { type: 'number', value: Infinity, unit: null },
    { type: 'number', value: NaN, unit: null },
    { type: 'number', value: '1', unit: null },
    { type: 'number', value: 1, unit: 2 },
    { unit: null },
    { extra: true },
    { type: 'multi', value: ['x', 'x'] },
    { type: 'multi', value: [1] },
  ])('rejects malformed branch %#', (change) => {
    expect(recognizes(document([value(change)]))).toBe(false);
  });

  it('rejects family-null values and duplicate tuples regardless of owner/type', () => {
    expect(recognizes({ ...document([text()]), familyCode: null })).toBe(false);
    expect(
      recognizes(
        document([
          text(),
          value({ owner: 'sellable', type: 'boolean', value: true }),
        ]),
      ),
    ).toBe(false);
  });

  it('does not mutate frozen rejected input', () => {
    const input = document([value({ extra: 'retain' })]);
    const before = JSON.stringify(input);
    freeze(input);
    expect(recognizes(input)).toBe(false);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(['root', 'value', 'media', 'multi', 'values'])(
    'rejects accessors at %s without executing getters',
    (where) => {
      const getter = jest.fn(() => {
        throw new Error('must not execute');
      });
      const input = document([value({ type: 'multi', value: ['x'] })]);
      const first = (input.values as Record<string, unknown>[])[0];
      const target =
        where === 'root'
          ? input
          : where === 'value'
            ? first
            : where === 'multi'
              ? first.value
              : input[where === 'media' ? 'mediaRefs' : 'values'];
      Object.defineProperty(
        target,
        where === 'root' ? 'commercialTitle' : where === 'value' ? 'code' : '0',
        { get: getter, enumerable: true, configurable: true },
      );
      expect(recognizes(input)).toBe(false);
      expect(getter).not.toHaveBeenCalled();
    },
  );

  it.each([
    'hidden',
    'symbol',
    'array-hidden',
    'array-symbol',
    'extra',
    'sparse',
    'class',
    'cycle',
  ])('rejects nondata/decorated shapes: %s', (kind) => {
    const input = document([text()]);
    if (kind === 'hidden') Object.defineProperty(input, 'hidden', { value: 1 });
    if (kind === 'symbol')
      Object.defineProperty(input, Symbol('extra'), { value: 1 });
    if (kind === 'array-hidden')
      Object.defineProperty(input.mediaRefs, 'hidden', { value: 1 });
    if (kind === 'array-symbol')
      Object.defineProperty(input.mediaRefs, Symbol('extra'), { value: 1 });
    if (kind === 'extra')
      Object.assign(input.mediaRefs as string[], { extra: true });
    if (kind === 'sparse') input.mediaRefs = new Array(1);
    if (kind === 'class')
      input.values = [
        new (class {
          code = '';
        })(),
      ];
    if (kind === 'cycle') input.values = [input];
    expect(recognizes(input)).toBe(false);
  });

  it.each([
    new Error('reflection'),
    new TypeError('MALFORMED'),
    Symbol('sentinel'),
  ])('propagates unexpected reflection failure by identity %#', (failure) => {
    for (const trap of [
      'getPrototypeOf',
      'ownKeys',
      'getOwnPropertyDescriptor',
    ]) {
      const input = new Proxy(document(), {
        [trap]: () => {
          // Non-Error throws must retain identity too.
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw failure;
        },
      });
      let caught: unknown;
      try {
        recognizes(input);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(failure);
    }
  });
});
