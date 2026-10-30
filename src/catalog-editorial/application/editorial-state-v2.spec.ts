import type { ArchivedOptionWarning } from '../domain/contextual-document';
import type { EditorialDocumentJson } from '../domain/editorial-document-mode';
import {
  createEditorialStateV2,
  type RawStoredEditorialStateV2,
} from './editorial-state-v2';

const revision = `ev2-sha256-${'a'.repeat(64)}`;
const absent: RawStoredEditorialStateV2 = {
  cycle: null,
  draft: null,
  published: null,
};
const legacy = {
  commercialTitle: ' Historical ',
  description: null,
  mediaRefs: ['second', 'first'],
  familyCode: 'old.family',
  values: [],
};
const production = {
  schemaVersion: 2,
  ...legacy,
  values: [
    {
      code: 'historical.range',
      owner: 'product',
      variantId: 'conflicting-variant',
      state: 'known',
      payload: { type: 'range', min: 9, max: -0, unit: 'old.unit' },
      evidence: null,
    },
  ],
  facts: [],
};

function freezeJson(value: EditorialDocumentJson): void {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freezeJson);
    Object.freeze(value);
  }
}

function expectDetached(
  actual: EditorialDocumentJson,
  original: EditorialDocumentJson,
): void {
  expect(actual).toStrictEqual(original);
  if (original !== null && typeof original === 'object') {
    expect(actual).not.toBe(original);
    for (const [key, value] of Object.entries(original)) {
      const descriptor = Object.getOwnPropertyDescriptor(actual, key);
      expect(descriptor).toBeDefined();
      expectDetached(descriptor!.value as EditorialDocumentJson, value);
    }
  }
}

describe('createEditorialStateV2 fresh response', () => {
  it('returns the exact absent-state wrapper and preserves admitted R', () => {
    expect(createEditorialStateV2(revision, absent)).toStrictEqual({
      contractVersion: 2,
      vocabularyRevision: revision,
      state: { cycle: null, draft: null, published: null },
    });
  });

  it('keeps existing cycle with both slots absent and omits empty warnings', () => {
    expect(
      createEditorialStateV2(revision, { ...absent, cycle: 12, warnings: [] }),
    ).toStrictEqual({
      contractVersion: 2,
      vocabularyRevision: revision,
      state: { cycle: 12, draft: null, published: null },
    });
  });

  it.each<[string, EditorialDocumentJson]>([
    ['empty current document', { ...production, values: [] }],
    ['historical relational conflicts', production],
    ['raw strings', { ...production, commercialTitle: '\ud800' }],
  ])(
    'copies direct %s into both slots without fresh admission',
    (_name, document) => {
      freezeJson(document);
      const input = {
        cycle: 7,
        draft: { revision: 11, basePublishedRevision: 5, document },
        published: { revision: 5, document },
      };
      const result = createEditorialStateV2(revision, input);
      expect(result.state).toStrictEqual(input);
      expectDetached(result.state.draft!.document, document);
      expectDetached(result.state.published!.document, document);
      expect(result.state.draft!.document).not.toBe(
        result.state.published!.document,
      );
    },
  );

  it('keeps distinct documents and nullable base without counter arithmetic', () => {
    const input = {
      cycle: 3,
      draft: { revision: 4, basePublishedRevision: null, document: production },
      published: {
        revision: 9,
        document: { ...production, commercialTitle: 'Other' },
      },
    };
    expect(createEditorialStateV2(revision, input).state).toStrictEqual(input);
  });

  it.each(['draft', 'published'] as const)(
    'rejects obsolete or malformed %s documents rather than wrapping or omitting',
    (slot) => {
      const invalidDocuments: EditorialDocumentJson[] = [
        {},
        legacy,
        { schemaVersion: 3, future: ['retain'] },
        { schemaVersion: 2, facts: [] },
        '\ud800',
        -0,
        false,
        null,
        [null, { schemaVersion: 99 }],
        ...['legacy', 'unsupported', 'production-v2'].map((mode) => ({
          mode,
          document: production,
        })),
        { ...production, unknown: { nested: [true, null] } },
        Object.fromEntries<EditorialDocumentJson>([
          ...Object.entries(production),
          ['__proto__', { extra: -0 }],
        ]),
      ];
      for (const document of invalidDocuments) {
        freezeJson(document);
        const input = {
          ...absent,
          cycle: 1,
          ...(slot === 'draft'
            ? { draft: { revision: 1, basePublishedRevision: null, document } }
            : { published: { revision: 1, document } }),
        };
        Object.freeze(input);
        expect(() => createEditorialStateV2(revision, input)).toThrow(
          new TypeError('Expected an editorial document V2'),
        );
        expect(input[slot]?.document).toBe(document);
        expect(input[slot === 'draft' ? 'published' : 'draft']).toBeNull();
      }
    },
  );

  it('preserves shared current children, strings, negative zero and array order independently', () => {
    const document = {
      ...production,
      values: [production.values[0], production.values[0]],
    };
    freezeJson(document);
    const result = createEditorialStateV2(revision, {
      ...absent,
      published: { revision: 13, document },
    });
    const copy = result.state.published!.document;
    expectDetached(copy, document);
    expect(copy.values[0]).not.toBe(copy.values[1]);
    copy.mediaRefs.push('response-only');
    expect(document.mediaRefs).toStrictEqual(['second', 'first']);
    const value = copy.values[0];
    expect(
      value.state === 'known' &&
        value.payload.type === 'range' &&
        Object.is(value.payload.max, -0),
    ).toBe(true);
  });

  it('propagates unexpected recognition failures by identity', () => {
    const sentinel = new TypeError('Expected an editorial document V2');
    const document = new Proxy(production, {
      ownKeys() {
        throw sentinel;
      },
    });
    let caught: unknown;
    try {
      createEditorialStateV2(revision, {
        ...absent,
        published: { revision: 1, document },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(sentinel);
  });

  it('copies nonempty warnings exactly, in order, without recomputing', () => {
    const warnings: ArchivedOptionWarning[] = [
      {
        code: 'ARCHIVED_OPTION',
        familyId: 'old.family',
        definitionId: 'second',
        owner: 'sellable',
        variantId: 'variant',
        optionCode: 'old.option',
      },
      {
        code: 'ARCHIVED_OPTION',
        familyId: 'other.family',
        definitionId: 'first',
        owner: 'product',
        variantId: null,
        optionCode: 'other.option',
      },
    ];
    warnings.forEach(Object.freeze);
    Object.freeze(warnings);
    const input = Object.freeze({ ...absent, warnings });
    const result = createEditorialStateV2(revision, input);
    expect(result.state.warnings).toStrictEqual(warnings);
    expect(result.state.warnings).not.toBe(warnings);
    result.state.warnings!.forEach((warning, index) => {
      expect(warning).not.toBe(warnings[index]);
      expect(Object.keys(warning)).toStrictEqual(Object.keys(warnings[index]));
    });
    result.state.warnings![0].optionCode = 'response-only';
    expect(warnings[0].optionCode).toBe('old.option');
  });
});
