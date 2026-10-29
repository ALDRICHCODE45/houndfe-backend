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

  it.each<[string, EditorialDocumentJson, string]>([
    ['empty legacy', {}, 'legacy'],
    ['full legacy', legacy, 'legacy'],
    ['historical V2 relational conflict', production, 'production-v2'],
    ['future version', { schemaVersion: 3, future: ['retain'] }, 'unsupported'],
    ['malformed V2', { schemaVersion: 2, facts: [] }, 'unsupported'],
    ['string JSON', '\ud800', 'legacy'],
    ['number JSON', -0, 'legacy'],
    ['boolean JSON', false, 'legacy'],
    ['null JSON', null, 'legacy'],
    ['array JSON', [null, { schemaVersion: 99 }], 'legacy'],
  ])(
    'classifies and copies %s in both present slots',
    (_name, document, mode) => {
      freezeJson(document);
      const result = createEditorialStateV2(revision, {
        cycle: 7,
        draft: { revision: 11, basePublishedRevision: 5, document },
        published: { revision: 5, document },
      });
      expect(result.state).toStrictEqual({
        cycle: 7,
        draft: {
          revision: 11,
          basePublishedRevision: 5,
          document: { mode, document },
        },
        published: { revision: 5, document: { mode, document } },
      });
      expectDetached(result.state.draft!.document.document, document);
      expectDetached(result.state.published!.document.document, document);
      if (document !== null && typeof document === 'object') {
        expect(result.state.draft!.document.document).not.toBe(
          result.state.published!.document.document,
        );
      }
    },
  );

  it.each<[string, EditorialDocumentJson, string, EditorialDocumentJson]>([
    ['legacy', legacy, 'unsupported', { schemaVersion: 8 }],
    ['unsupported', { schemaVersion: 8 }, 'production-v2', production],
    ['production-v2', production, 'legacy', {}],
  ])(
    'keeps independent draft mode %s with a different published mode',
    (draftMode, draftDocument, publishedMode, publishedDocument) => {
      const result = createEditorialStateV2(revision, {
        cycle: 3,
        draft: {
          revision: 4,
          basePublishedRevision: null,
          document: draftDocument,
        },
        published: { revision: 9, document: publishedDocument },
      });
      expect(result.state.draft?.document.mode).toBe(draftMode);
      expect(result.state.published?.document.mode).toBe(publishedMode);
      expect(result.state.draft?.basePublishedRevision).toBeNull();
    },
  );

  it.each(['draft', 'published'] as const)(
    'distinguishes an absent %s slot from a present null document',
    (slot) => {
      const result = createEditorialStateV2(revision, {
        ...absent,
        cycle: 1,
        ...(slot === 'draft'
          ? {
              draft: {
                revision: 1,
                basePublishedRevision: null,
                document: null,
              },
            }
          : { published: { revision: 1, document: null } }),
      });
      expect(result.state[slot]?.document).toStrictEqual({
        mode: 'legacy',
        document: null,
      });
      expect(result.state[slot === 'draft' ? 'published' : 'draft']).toBeNull();
    },
  );

  it.each(['legacy', 'unsupported'] as const)(
    'preserves %s unknown keys, __proto__, strings, -0 and array order',
    (mode) => {
      const raw = Object.fromEntries<EditorialDocumentJson>([
        ['__proto__', { untouched: ['\ud800', -0, ' second ', 'first'] }],
        ['unknown', { nested: [true, null, { extra: 'retain' }] }],
      ]);
      if (mode === 'unsupported') raw.schemaVersion = 88;
      freezeJson(raw);
      const result = createEditorialStateV2(revision, {
        ...absent,
        published: { revision: 13, document: raw },
      });
      const view = result.state.published!.document;
      expect(view.mode).toBe(mode);
      expectDetached(view.document, raw);
      const proto = Object.getOwnPropertyDescriptor(view.document, '__proto__');
      expect(proto?.enumerable).toBe(true);
      expect(Object.getPrototypeOf(view.document)).toBe(Object.prototype);
      const copied = proto?.value as { untouched: EditorialDocumentJson[] };
      expect(Object.is(copied.untouched[1], -0)).toBe(true);
      copied.untouched.push('response-only');
      const original = Object.getOwnPropertyDescriptor(raw, '__proto__')
        ?.value as { untouched: EditorialDocumentJson[] };
      expect(original.untouched).toStrictEqual([
        '\ud800',
        -0,
        ' second ',
        'first',
      ]);
    },
  );

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
