import {
  createEditorialWriteRequestV2 as create,
  type EditorialWriteOperationV2,
} from './editorial-write-request-v2';
import { parseDocumentShapeV2 } from '../domain/editorial-document-shape-v2';
import { EditorialDocumentShapeError } from '../domain/editorial-document-shape-error';

const revision = `ev2-sha256-${'a'.repeat(64)}`;
const headers = () => ({
  vocabularyRevision: revision,
  careConfirmation: null,
});
const transition = () => ({ expectedCycle: 1, expectedRevision: 2 });
const document = () => ({
  schemaVersion: 2,
  commercialTitle: '\ud800',
  description: '',
  mediaRefs: ['b', 'a', 'b'],
  familyCode: null,
  values: [
    {
      code: '',
      owner: 'product',
      variantId: 'old',
      state: 'known',
      evidence: null,
      payload: { type: 'number', value: -2, unit: null },
    },
    {
      code: '',
      owner: 'product',
      variantId: 'old',
      state: 'known',
      evidence: null,
      payload: { type: 'multi', value: ['b', 'a', 'b'] },
    },
    {
      code: 'range',
      owner: 'sellable',
      variantId: null,
      state: 'known',
      evidence: null,
      payload: { type: 'range', min: 3, max: 1, unit: '' },
    },
  ],
  facts: [
    {
      variantId: null,
      presentation: '',
      declarations: [],
      careReview: { state: 'unknown' },
    },
  ],
});
function reject(
  operation: EditorialWriteOperationV2,
  h: unknown,
  body: unknown,
) {
  expect(() => create(operation, h, body)).toThrow(
    new TypeError('Expected an editorial write request V2'),
  );
}
function freezeTree(value: unknown) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeTree);
    Object.freeze(value);
  }
}
function detached(input: unknown, output: unknown) {
  if (input && typeof input === 'object') {
    expect(output).not.toBe(input);
    for (const key of Object.keys(input))
      detached(Reflect.get(input, key), Reflect.get(output as object, key));
  }
}

describe('editorial write request V2 (S2, contract §§3–4)', () => {
  it.each([
    ['initialize', { expectedCycle: null }],
    ['initialize', { expectedCycle: 1 }],
    ['save', { ...transition(), document: document() }],
    ['publish', transition()],
    ['discard', transition()],
  ] as const)('constructs exact %s wrapper and body', (operation, body) => {
    const h = headers();
    const result = create(operation, h, body);
    expect(result).toStrictEqual({
      receiptVersion: 2,
      contractVersion: 2,
      ...h,
      body,
    });
    expect(result).not.toBe(body);
    expect(result.body).not.toBe(body);
  });

  it.each([
    ['save', null],
    ['publish', 'review-v1'],
    ['publish', null],
    ['initialize', null],
    ['discard', null],
  ] as const)(
    'retains permitted %s confirmation %s',
    (operation, careConfirmation) => {
      const body =
        operation === 'initialize'
          ? { expectedCycle: null }
          : operation === 'save'
            ? { ...transition(), document: document() }
            : transition();
      const h = { ...headers(), careConfirmation };
      expect(create(operation, h, body)).toStrictEqual({
        receiptVersion: 2,
        contractVersion: 2,
        ...h,
        body,
      });
    },
  );

  it.each([
    '',
    `EV2-sha256-${'a'.repeat(64)}`,
    `ev2-sha256-${'A'.repeat(64)}`,
    revision.slice(0, -1),
    `${revision}a`,
    `${revision}\n`,
    `${revision}\r\n`,
    `${revision},${revision}`,
    null,
    2,
  ])('rejects malformed R: %p', (vocabularyRevision) => {
    reject('publish', { ...headers(), vocabularyRevision }, transition());
  });

  it.each([
    { ...headers(), careConfirmation: 'review-v2' },
    { ...headers(), careConfirmation: 1 },
    { ...headers(), extra: null },
    {},
    null,
    [],
  ])('rejects malformed normalized headers %p', (h) =>
    reject('publish', h, transition()),
  );

  it('requires each header key even when its value is null', () => {
    for (const key of Object.keys(headers())) {
      const h: Record<string, unknown> = headers();
      delete h[key];
      reject('publish', h, transition());
    }
  });

  it.each(['initialize', 'save', 'discard'] as const)(
    'forbids confirmation on %s',
    (operation) => {
      reject(
        operation,
        { ...headers(), careConfirmation: 'review-v1' },
        operation === 'initialize'
          ? { expectedCycle: null }
          : operation === 'save'
            ? { ...transition(), document: document() }
            : transition(),
      );
    },
  );
  it.each(['initialize', 'save', 'publish', 'discard'] as const)(
    'rejects every obsolete adoption key on %s without mutating input',
    (operation) => {
      const body =
        operation === 'initialize'
          ? { expectedCycle: null }
          : operation === 'save'
            ? { ...transition(), document: document() }
            : transition();
      for (const adoption of [null, 'legacy-to-v2', undefined, '', true]) {
        const h = { ...headers(), adoption };
        const before = structuredClone({ h, body });
        freezeTree(h);
        freezeTree(body);
        reject(operation, h, body);
        expect({ h, body }).toEqual(before);
      }
    },
  );

  it.each([undefined, null, '', 'SAVE', 'toString', 2])(
    'rejects runtime operation %p',
    (operation) => {
      reject(operation as EditorialWriteOperationV2, headers(), transition());
    },
  );

  it.each([
    ['initialize', transition()],
    ['initialize', {}],
    ['save', transition()],
    ['save', { ...transition(), document: document(), schemaVersion: 2 }],
    ['publish', { ...transition(), document: document() }],
    ['discard', { ...transition(), operation: 'discard' }],
    ['publish', { expectedCycle: 1 }],
    ['publish', null],
    ['publish', []],
  ] as const)('rejects closed-body mismatch for %s: %p', (operation, body) =>
    reject(operation, headers(), body),
  );

  it.each([0, -1, 1.5, NaN, Infinity, -Infinity, '1', null, undefined])(
    'rejects invalid positive integer %p',
    (value) => {
      reject('initialize', headers(), {
        expectedCycle: value === null ? 0 : value,
      });
      reject('publish', headers(), { ...transition(), expectedCycle: value });
      reject('discard', headers(), {
        ...transition(),
        expectedRevision: value,
      });
      reject('save', headers(), {
        ...transition(),
        expectedRevision: value,
        document: document(),
      });
    },
  );

  it('does not impose storage or safe-integer limits', () => {
    for (const value of [
      2 ** 32,
      Number.MAX_SAFE_INTEGER + 1,
      Number.MAX_VALUE,
    ]) {
      const body = { expectedCycle: value, expectedRevision: value };
      expect(create('publish', headers(), body).body).toStrictEqual(body);
      expect(
        create('initialize', headers(), { expectedCycle: value }).body,
      ).toStrictEqual({ expectedCycle: value });
    }
  });

  it('detaches the frozen real-parser tree without repairing historical conflicts', () => {
    const body = { ...transition(), document: document() };
    const expected = parseDocumentShapeV2(body.document);
    const h = headers();
    freezeTree(body);
    freezeTree(h);
    const result = create('save', h, body);
    expect(result.body).toStrictEqual({ ...transition(), document: expected });
    detached(body, result.body);
    expect(body.document).toStrictEqual(expected);
  });

  it('retains changed receipt identity values without comparison or hashing', () => {
    const body = { ...transition(), document: document() };
    expect(
      create(
        'save',
        {
          ...headers(),
          vocabularyRevision: `ev2-sha256-${'b'.repeat(64)}`,
        },
        body,
      ),
    ).toMatchObject({
      vocabularyRevision: `ev2-sha256-${'b'.repeat(64)}`,
      body,
    });
    expect(
      create(
        'publish',
        { ...headers(), careConfirmation: 'review-v1' },
        { expectedCycle: 3, expectedRevision: 4 },
      ),
    ).toMatchObject({
      careConfirmation: 'review-v1',
      body: { expectedCycle: 3, expectedRevision: 4 },
    });
  });

  it('propagates nested deliberate shape errors without parent reclassification', () => {
    const body = {
      ...transition(),
      document: {
        ...document(),
        values: [
          {
            ...document().values[0],
            payload: { type: 'number', value: Infinity, unit: null },
          },
        ],
      },
    };
    expect(() => create('save', headers(), body)).toThrow(
      EditorialDocumentShapeError,
    );
    expect(() => create('save', headers(), body)).toThrow(
      'Expected a known payload shape V2',
    );
  });

  it.each(['headers', 'body'] as const)(
    'rejects unsafe %s descriptors without invoking getters',
    (target) => {
      let calls = 0;
      const base = target === 'headers' ? headers() : transition();
      const key = target === 'headers' ? 'vocabularyRevision' : 'expectedCycle';
      const bad = [
        Object.defineProperty({ ...base }, key, {
          get() {
            calls++;
            return 1;
          },
          enumerable: true,
        }),
        Object.defineProperty({ ...base }, key, {
          value: 1,
          enumerable: false,
        }),
        Object.defineProperty({ ...base }, 'hidden', { value: 1 }),
        { ...base, [Symbol('extra')]: 1 },
        Object.create(base) as unknown,
      ];
      for (const value of bad)
        reject(
          'publish',
          target === 'headers' ? value : headers(),
          target === 'body' ? value : transition(),
        );
      expect(calls).toBe(0);
    },
  );

  it('accepts null-prototype data records', () => {
    const h: unknown = Object.assign(Object.create(null), headers());
    const body: unknown = Object.assign(Object.create(null), transition());
    expect(create('publish', h, body).body).toStrictEqual(transition());
  });

  it.each([
    new Error('reflection'),
    new TypeError('Expected an editorial write request V2'),
    { sentinel: true },
  ])('propagates unexpected reflection identity %p', (sentinel) => {
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- Verify non-Error identity too.
          throw sentinel;
        },
      },
    );
    for (const invoke of [
      () => create('publish', proxy, transition()),
      () => create('publish', headers(), proxy),
      () =>
        create('save', headers(), {
          ...transition(),
          document: { ...document(), values: [proxy] },
        }),
    ]) {
      try {
        invoke();
        throw new Error('Expected failure');
      } catch (error) {
        expect(error).toBe(sentinel);
      }
    }
  });
});
