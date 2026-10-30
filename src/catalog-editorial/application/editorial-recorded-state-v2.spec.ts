import { decodeRecordedEditorialStateV2 as decode } from './editorial-recorded-state-v2';

const R = `ev2-sha256-${'a'.repeat(64)}`;
const warning = {
  code: 'ARCHIVED_OPTION',
  familyId: '',
  definitionId: '\ud800',
  owner: 'product',
  variantId: 'old',
  optionCode: '',
};
const production = () => ({
  schemaVersion: 2,
  commercialTitle: null,
  description: '',
  mediaRefs: ['x', 'x'],
  familyCode: null,
  values: [
    {
      code: '',
      owner: 'product',
      variantId: 'old',
      state: 'known',
      payload: { type: 'range', min: 9, max: -0, unit: '' },
      evidence: { sourceRef: '', verifiedOn: 'old malformed date' },
    },
  ],
  facts: [],
});
function envelope(...documents: [] | [unknown]) {
  const document = documents.length ? documents[0] : production();
  return {
    contractVersion: 2,
    vocabularyRevision: R,
    state: {
      cycle: null,
      draft: {
        revision: 1,
        basePublishedRevision: null,
        document,
      },
      published: null,
    },
  };
}
function rejected(input: unknown) {
  expect(() => decode(input)).toThrow(
    new TypeError('Expected a recorded editorial state V2'),
  );
}

describe('recorded editorial state V2 (S2, contract §§4–5)', () => {
  it('preserves exact slots, counters, warnings presence, order and duplicates', () => {
    const input = envelope();
    expect(decode(input)).toEqual(input);
    expect(Object.hasOwn(decode(input).state, 'warnings')).toBe(false);
    for (const warnings of [
      [],
      [warning, { ...warning, owner: 'sellable', variantId: null }, warning],
    ]) {
      const withWarnings = { ...input, state: { ...input.state, warnings } };
      expect(decode(withWarnings)).toEqual(withWarnings);
      expect(Object.hasOwn(decode(withWarnings).state, 'warnings')).toBe(true);
    }
    const absent = {
      ...input,
      state: {
        cycle: 2147483647,
        draft: null,
        published: {
          revision: 2147483647,
          document: production(),
        },
      },
    };
    expect(decode(absent)).toEqual(absent);
    const unrelatedCounters = {
      ...input,
      state: {
        ...input.state,
        draft: {
          ...input.state.draft,
          basePublishedRevision: 2147483647,
        },
      },
    };
    expect(decode(unrelatedCounters)).toEqual(unrelatedCounters);
  });

  it.each(['draft', 'published'] as const)(
    'rejects legacy, unsupported and wrapped documents in %s',
    (slot) => {
      for (const document of [
        null,
        {},
        { schemaVersion: 99, extra: [-0, '\ud800', true] },
        ...['legacy', 'unsupported', 'production-v2'].map((mode) => ({
          mode,
          document: production(),
        })),
      ]) {
        const input = envelope();
        rejected({
          ...input,
          state: {
            ...input.state,
            [slot]:
              slot === 'draft'
                ? { ...input.state.draft, document }
                : { revision: 1, document },
          },
        });
      }
    },
  );

  it('keeps direct historical conflicts and raw strings, not parser reconstruction', () => {
    const input = envelope(production());
    expect(decode(input)).toEqual(input);
    const output = decode(input).state.draft!.document;
    const value = output.values[0];
    expect(
      value.state === 'known' &&
        value.payload.type === 'range' &&
        Object.is(value.payload.max, -0),
    ).toBe(true);
  });

  it.each(['missing facts', 'wrong static axis'])(
    'rejects production %s without downgrading',
    (kind) => {
      const document: Record<string, unknown> = production();
      if (kind === 'missing facts') delete document.facts;
      else
        document.facts = [
          {
            variantId: null,
            presentation: '',
            careReview: null,
            declarations: [
              {
                key: 'relevantDimensionCodes',
                state: 'known',
                value: { codes: ['measure.fit.neck'], toyTypes: [] },
                evidence: { sourceRef: '', verifiedOn: '' },
                basis: '',
              },
            ],
          },
        ];
      rejected(envelope(document));
    },
  );

  it.each([0, -1, 1.5, 2147483648, NaN, Infinity, '1', undefined])(
    'rejects counter %p',
    (counter) => {
      const input = envelope();
      for (const target of ['cycle', 'revision', 'basePublishedRevision']) {
        const bad = {
          ...input,
          state: { ...input.state, draft: { ...input.state.draft } },
        };
        if (target === 'cycle') Object.assign(bad.state, { cycle: counter });
        else Object.assign(bad.state.draft, { [target]: counter });
        rejected(bad);
      }
    },
  );

  it('rejects missing, extra and wrong primitive fields on every closed container', () => {
    const input = envelope();
    const containers = [
      input,
      input.state,
      input.state.draft,
      production(),
      { revision: 1, document: production() },
      warning,
    ];
    const wrap = (index: number, value: unknown): unknown => {
      if (index === 0) return value;
      if (index === 1) return { ...input, state: value };
      if (index === 2)
        return { ...input, state: { ...input.state, draft: value } };
      if (index === 3) return envelope(value);
      return {
        ...input,
        state: {
          ...input.state,
          ...(index === 4 ? { published: value } : { warnings: [value] }),
        },
      };
    };
    containers.forEach((container, index) => {
      rejected(wrap(index, { ...container, extra: null }));
      for (const key of Object.keys(container)) {
        const missing: Record<string, unknown> = { ...container };
        delete missing[key];
        rejected(wrap(index, missing));
        rejected(wrap(index, { ...container, [key]: false }));
      }
    });
    for (const vocabularyRevision of [
      R.toUpperCase(),
      `${R}\n`,
      R.slice(1),
      `${R}a`,
      null,
    ])
      rejected({ ...input, vocabularyRevision });
  });

  it('rejects non-JSON values, sparse/decorated arrays, nonplain records and cycles', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const arrayCycle: unknown[] = [];
    arrayCycle.push(arrayCycle);
    for (const document of [
      NaN,
      Infinity,
      -Infinity,
      undefined,
      () => 1,
      Symbol(),
      1n,
      [undefined],
      Array(1),
      Object.assign([], { extra: 1 }),
      new Date(),
      cyclic,
      arrayCycle,
      Object.defineProperty({}, 'hidden', { value: 1 }),
      { [Symbol()]: 1 },
    ])
      rejected(envelope(document));
    rejected(envelope({ ...production(), values: arrayCycle }));
  });

  it('rejects accessors/hidden/symbol fields without calling getters in records and arrays', () => {
    const getter = jest.fn(() => null);
    const warningCopy = { ...warning };
    for (const target of [{}, [], envelope(), warningCopy]) {
      const key = Array.isArray(target) ? '0' : (Object.keys(target)[0] ?? 'x');
      Object.defineProperty(target, key, { get: getter, enumerable: true });
      rejected(
        target === warningCopy
          ? {
              ...envelope(),
              state: { ...envelope().state, warnings: [target] },
            }
          : target,
      );
      rejected(envelope(target));
    }
    expect(getter).not.toHaveBeenCalled();
    for (const key of ['hidden', Symbol()]) {
      const input = envelope();
      Object.defineProperty(input.state, key, { value: null });
      rejected(input);
    }
  });

  it.each([
    new Error('reflection'),
    new TypeError('Expected a recorded editorial state V2'),
    'sentinel',
  ])('propagates unexpected reflection identity %p', (sentinel) => {
    for (const trap of [
      'ownKeys',
      'getPrototypeOf',
      'getOwnPropertyDescriptor',
    ]) {
      const proxy = new Proxy(envelope(), {
        [trap]: () => {
          // Non-Error throws also have to survive reflection unchanged.
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw sentinel;
        },
      });
      for (const input of [
        proxy,
        envelope(proxy),
        envelope({ ...production(), values: [proxy] }),
      ]) {
        try {
          decode(input);
          throw new Error('did not throw');
        } catch (error) {
          expect(error).toBe(sentinel);
        }
      }
    }
  });

  it('detaches shared current children independently without invoking prototype setters', () => {
    const shared = production().values[0];
    shared.code = '__proto__';
    const document = { ...production(), values: [shared, shared] };
    const input = {
      ...envelope(document),
      state: { ...envelope(document).state, warnings: [warning] },
    };
    const output = decode(input);
    expect(output).toEqual(input);
    const copied = output.state.draft!.document;
    expect(copied.values[0]).not.toBe(copied.values[1]);
    expect(copied.values[0]).not.toBe(shared);
    expect(Object.getPrototypeOf(copied)).toBe(Object.prototype);
    copied.values[0].code = 'changed';
    output.state.warnings![0].optionCode = 'changed';
    expect(shared.code).toBe('__proto__');
    expect(copied.values[1].code).toBe('__proto__');
    expect(warning.optionCode).toBe('');
    const value = copied.values[0];
    expect(
      value.state === 'known' &&
        value.payload.type === 'range' &&
        Object.is(value.payload.max, -0),
    ).toBe(true);
    rejected(
      envelope(
        Object.fromEntries<unknown>([
          ...Object.entries(document),
          ['__proto__', shared],
        ]),
      ),
    );
  });

  it('accepts null-prototype records and dense arrays with alternate prototypes', () => {
    const document = production();
    Object.setPrototypeOf(document, null);
    const input = envelope(document);
    Object.setPrototypeOf(input.state, null);
    expect(decode(input)).toEqual(input);
    Object.setPrototypeOf(document.mediaRefs, null);
    expect(decode(input).state.draft!.document.mediaRefs).toEqual(['x', 'x']);
  });
});
