import {
  emptyDocument,
  type EditorialDocument,
  type EditorialValue,
  type Owner,
} from './document';
import type { KnownPayloadV2 } from './editorial-known-payload-shape-v2';
import { parseDocumentShapeV2 } from './editorial-document-shape-v2';
import { createLegacyAdoptionBuffer as create } from './editorial-legacy-adoption-buffer';

function known(
  code: string,
  owner: Owner,
  variantId: string | null,
  payload: KnownPayloadV2,
) {
  return { code, owner, variantId, state: 'known', payload, evidence: null };
}

function legacy(
  code: string,
  owner: Owner,
  variantId: string | null,
  payload: Exclude<KnownPayloadV2, { type: 'range' }>,
): EditorialValue {
  return { code, owner, variantId, ...payload };
}

function historical(): EditorialDocument {
  return {
    commercialTitle: '  old\ud800 title  ',
    description: '',
    mediaRefs: ['deleted-z', 'unknown-a'],
    familyCode: 'deleted-family',
    values: [
      legacy('text', 'product', null, { type: 'text', value: ' \ud800 ' }),
      legacy('flag', 'sellable', 'deleted', { type: 'boolean', value: false }),
      legacy('n', 'sellable', null, { type: 'number', value: -0, unit: null }),
      legacy('n', 'sellable', 'unknown', {
        type: 'number',
        value: -1.25,
        unit: 'old-unit',
      }),
      legacy('one', 'product', null, { type: 'single', value: ' old option ' }),
      legacy('many', 'sellable', '', {
        type: 'multi',
        value: ['z', '', '\ud800', 'a'],
      }),
    ],
  };
}

function freeze(input: unknown): void {
  if (input && typeof input === 'object') {
    for (const value of Object.values(input)) freeze(value);
    Object.freeze(input);
  }
}

function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected a thrown value');
}

const message = 'Expected a recognizable legacy document';

describe('createLegacyAdoptionBuffer (S2, contract §5)', () => {
  it('creates the exact empty V2 buffer from the real legacy emptyDocument', () => {
    expect(create(emptyDocument())).toStrictEqual({
      schemaVersion: 2,
      commercialTitle: null,
      description: null,
      mediaRefs: [],
      familyCode: null,
      values: [],
      facts: [],
    });
  });

  it('preserves every legacy branch, field, identity and order without inventing evidence/facts', () => {
    const input = historical();
    const result = create(input);
    expect(result).toStrictEqual({
      schemaVersion: 2,
      commercialTitle: '  old\ud800 title  ',
      description: '',
      mediaRefs: ['deleted-z', 'unknown-a'],
      familyCode: 'deleted-family',
      values: [
        known('text', 'product', null, { type: 'text', value: ' \ud800 ' }),
        known('flag', 'sellable', 'deleted', { type: 'boolean', value: false }),
        known('n', 'sellable', null, { type: 'number', value: -0, unit: null }),
        known('n', 'sellable', 'unknown', {
          type: 'number',
          value: -1.25,
          unit: 'old-unit',
        }),
        known('one', 'product', null, {
          type: 'single',
          value: ' old option ',
        }),
        known('many', 'sellable', '', {
          type: 'multi',
          value: ['z', '', '\ud800', 'a'],
        }),
      ],
      facts: [],
    });
    expect(Object.keys(result).sort()).toEqual([
      'commercialTitle',
      'description',
      'facts',
      'familyCode',
      'mediaRefs',
      'schemaVersion',
      'values',
    ]);
    for (const value of result.values) {
      expect(Object.keys(value).sort()).toEqual([
        'code',
        'evidence',
        'owner',
        'payload',
        'state',
        'variantId',
      ]);
      if (value.state !== 'known') throw new Error('Expected known');
      expect(Object.keys(value.payload).sort()).toEqual(
        value.payload.type === 'number'
          ? ['type', 'unit', 'value']
          : ['type', 'value'],
      );
    }
    expect(parseDocumentShapeV2(result)).toStrictEqual(result);
  });

  it('detaches all nested references from recursively frozen input and every other call', () => {
    const input = historical();
    const before = historical();
    freeze(input);
    const first = create(input);
    const second = create(input);
    expect(first).not.toBe(input);
    expect(first.mediaRefs).not.toBe(input.mediaRefs);
    expect(first.values).not.toBe(input.values);
    first.values.forEach((value, index) => {
      expect(value).not.toBe(input.values[index]);
      expect(value).not.toBe(second.values[index]);
      if (value.state === 'known' && second.values[index].state === 'known') {
        expect(value.payload).not.toBe(second.values[index].payload);
        if (value.payload.type === 'multi') {
          expect(value.payload.value).not.toBe(input.values[index].value);
          value.payload.value.push('edited');
        }
        if (value.payload.type === 'text') value.payload.value = 'edited';
      }
      value.code = 'edited';
    });
    first.mediaRefs.push('edited');
    first.values.push(first.values[0]);
    first.facts.push({
      variantId: null,
      presentation: '',
      declarations: [],
      careReview: null,
    });
    first.commercialTitle = 'edited';
    expect(input).toStrictEqual(before);
    expect(second).toStrictEqual(create(before));
    expect(first.facts).not.toBe(second.facts);
    expect(first.mediaRefs).not.toBe(second.mediaRefs);
  });

  it('does not impose fresh text or collection limits or reorder historical data', () => {
    const input = historical();
    input.commercialTitle = ' '.repeat(20000);
    input.description = '\ud800'.repeat(20000);
    input.mediaRefs = Array.from({ length: 1001 }, (_, i) => `old-${1001 - i}`);
    const multi = input.values[5];
    if (multi.type !== 'multi') throw new Error('Expected multi');
    multi.value = input.mediaRefs.slice();
    const result = create(input);
    expect(result.commercialTitle).toBe(input.commercialTitle);
    expect(result.description).toBe(input.description);
    expect(result.mediaRefs).toEqual(input.mediaRefs);
    const output = result.values[5];
    if (output.state !== 'known' || output.payload.type !== 'multi')
      throw new Error('Expected multi');
    expect(output.payload.value).toEqual(multi.value);
  });

  it.each<[string, () => unknown]>([
    ['null', () => null],
    ['array', () => []],
    ['scalar', () => 4],
    ['legacy mode only', () => ({})],
    ['V2', () => ({ ...emptyDocument(), schemaVersion: 2, facts: [] })],
    ['unsupported version', () => ({ ...emptyDocument(), schemaVersion: 3 })],
    ['extra root', () => ({ ...historical(), extra: true })],
    [
      'missing root',
      () => {
        const d = historical();
        return {
          description: d.description,
          mediaRefs: d.mediaRefs,
          familyCode: d.familyCode,
          values: d.values,
        };
      },
    ],
    ['duplicate media', () => ({ ...historical(), mediaRefs: ['a', 'a'] })],
    ['bad media', () => ({ ...historical(), mediaRefs: [4] })],
    ['family null values', () => ({ ...historical(), familyCode: null })],
    [
      'duplicate identity',
      () => {
        const d = historical();
        d.values.push(d.values[0]);
        return d;
      },
    ],
    [
      'extra value',
      () => {
        const d = historical();
        return { ...d, values: [{ ...d.values[0], extra: true }] };
      },
    ],
    [
      'missing value',
      () => ({
        ...historical(),
        values: [
          { code: 'x', owner: 'product', variantId: null, type: 'text' },
        ],
      }),
    ],
    [
      'product variant',
      () => {
        const d = historical();
        d.values[0].variantId = 'v';
        return d;
      },
    ],
    [
      'duplicate multi',
      () => ({
        ...historical(),
        values: [
          {
            code: 'x',
            owner: 'product',
            variantId: null,
            type: 'multi',
            value: ['a', 'a'],
          },
        ],
      }),
    ],
    [
      'bad multi',
      () => ({
        ...historical(),
        values: [
          {
            code: 'x',
            owner: 'product',
            variantId: null,
            type: 'multi',
            value: [1],
          },
        ],
      }),
    ],
    ...[NaN, Infinity, -Infinity].map(
      (value) =>
        [
          String(value),
          () => ({
            ...historical(),
            values: [
              {
                code: 'x',
                owner: 'product',
                variantId: null,
                type: 'number',
                value,
                unit: null,
              },
            ],
          }),
        ] as [string, () => unknown],
    ),
  ])(
    'rejects %s through the real recognizer without mutation',
    (_label, fixture) => {
      const input = fixture();
      freeze(input);
      const error = caught(() => create(input));
      expect(error).toBeInstanceOf(TypeError);
      expect((error as TypeError).message).toBe(message);
    },
  );

  it.each(['root', 'value', 'media', 'multi'])(
    'never executes a %s accessor',
    (location) => {
      const input = historical();
      const getter = jest.fn(() => {
        throw new Error('Getter executed');
      });
      const targets: Record<string, [object, string]> = {
        root: [input, 'commercialTitle'],
        value: [input.values[0], 'value'],
        media: [input.mediaRefs, '0'],
        multi: [input.values[5].value as string[], '0'],
      };
      const [target, key] = targets[location];
      Object.defineProperty(target, key, { enumerable: true, get: getter });
      expect(() => create(input)).toThrow(message);
      expect(getter).not.toHaveBeenCalled();
    },
  );

  it.each([new Error('reflection'), new TypeError(message), 'non-Error'])(
    'propagates unexpected reflection failures by identity: %p',
    (sentinel) => {
      const input = new Proxy(historical(), {
        getPrototypeOf() {
          // Deliberately exercise arbitrary JavaScript reflection failures.
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw sentinel;
        },
      });
      expect(caught(() => create(input))).toBe(sentinel);
    },
  );
});
