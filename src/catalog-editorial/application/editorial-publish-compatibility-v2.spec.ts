import { emptyDocument } from '../domain/document';
import type { EditorialDocumentJson } from '../domain/editorial-document-mode';
import { assertFreshPublishCompatibilityV2 } from './editorial-publish-compatibility-v2';

const upgrade = 'EDITORIAL_CLIENT_UPGRADE_REQUIRED';
const adoption = 'EDITORIAL_ADOPTION_REQUIRED';
const production = () => ({ schemaVersion: 2, ...emptyDocument(), facts: [] });
const slot = (document: EditorialDocumentJson) => ({ document });
const publishedCases = [
  { name: 'absent', published: null },
  { name: 'legacy', published: slot({ ...emptyDocument() }) },
  { name: 'production', published: slot(production()) },
  { name: 'unsupported', published: slot({ schemaVersion: 3 }) },
];

function rejectsExactly(run: () => void, message: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(Object.getPrototypeOf(caught)).toBe(Error.prototype);
  expect((caught as Error).message).toBe(message);
  expect(Object.keys(caught as Error)).toEqual([]);
}

function throwsIdentity(run: () => void, sentinel: unknown): void {
  let caught: unknown;
  let threw = false;
  try {
    run();
  } catch (error) {
    threw = true;
    caught = error;
  }
  expect(threw).toBe(true);
  expect(caught).toBe(sentinel);
}

function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}

const historical = () => {
  const value = {
    code: 'deleted.definition',
    owner: 'product',
    variantId: 'deleted.variant',
    state: 'known',
    payload: { type: 'range', min: 9, max: -1, unit: 'deleted.unit' },
    evidence: { sourceRef: '', verifiedOn: 'old-bad-date' },
  };
  const row = {
    variantId: null,
    presentation: '',
    declarations: [],
    careReview: null,
  };
  return {
    ...production(),
    description: '\ud800',
    mediaRefs: ['deleted', 'deleted'],
    values: [value, value],
    facts: [row, row],
  };
};
const wrongAxis = () => ({
  ...production(),
  facts: [
    {
      variantId: null,
      presentation: '',
      careReview: null,
      declarations: [
        {
          key: 'relevantFitCodes',
          state: 'known',
          value: ['measure.equipment.power'],
          evidence: { sourceRef: '', verifiedOn: 'old-bad-date' },
          basis: '',
        },
      ],
    },
  ],
});

describe('assertFreshPublishCompatibilityV2', () => {
  describe.each(publishedCases)('Published $name', ({ name, published }) => {
    it('requires adoption for legacy Draft unless Published requires upgrade', () => {
      rejectsExactly(
        () =>
          assertFreshPublishCompatibilityV2(
            slot({ ...emptyDocument() }),
            published,
          ),
        name === 'unsupported' ? upgrade : adoption,
      );
    });

    it('accepts production Draft unless Published requires upgrade', () => {
      const run = () =>
        assertFreshPublishCompatibilityV2(slot(production()), published);
      if (name === 'unsupported') rejectsExactly(run, upgrade);
      else expect(run()).toBeUndefined();
    });

    it('requires upgrade for unsupported Draft regardless of Published', () => {
      rejectsExactly(
        () =>
          assertFreshPublishCompatibilityV2(
            slot({ schemaVersion: 3 }),
            published,
          ),
        upgrade,
      );
    });
  });

  it.each<[string, EditorialDocumentJson]>([
    ['empty object', {}],
    ['present null JSON', null],
    ['malformed unversioned object', { values: 'old' }],
    ['array', []],
    ['scalar', false],
  ])(
    'requires adoption, not upgrade, for legacy Draft %s',
    (_name, document) => {
      rejectsExactly(
        () => assertFreshPublishCompatibilityV2(slot(document), null),
        adoption,
      );
    },
  );

  it('allows present null Published JSON with production Draft', () => {
    expect(
      assertFreshPublishCompatibilityV2(slot(production()), slot(null)),
    ).toBeUndefined();
  });

  it.each([
    ['malformed V2', { ...production(), values: null }],
    ['wrong static axis', wrongAxis()],
  ])('requires upgrade for %s in either slot', (_name, document) => {
    rejectsExactly(
      () =>
        assertFreshPublishCompatibilityV2(slot(document), slot(production())),
      upgrade,
    );
    rejectsExactly(
      () =>
        assertFreshPublishCompatibilityV2(slot(production()), slot(document)),
      upgrade,
    );
  });

  it('passes historical production conflicts in both slots without fresh validation', () => {
    const draft = historical();
    const published = historical();
    expect(
      assertFreshPublishCompatibilityV2(slot(draft), slot(published)),
    ).toBeUndefined();
    expect(draft.values[0].payload).toEqual({
      type: 'range',
      min: 9,
      max: -1,
      unit: 'deleted.unit',
    });
    expect(draft.values[0].evidence.verifiedOn).toBe('old-bad-date');
  });

  it.each([
    ['pass', historical(), historical(), null],
    ['adoption', { ...emptyDocument() }, historical(), adoption],
    [
      'Draft upgrade',
      { ...historical(), schemaVersion: 3 },
      historical(),
      upgrade,
    ],
    [
      'Published upgrade',
      historical(),
      { ...historical(), schemaVersion: 3 },
      upgrade,
    ],
  ] as const)(
    'does not mutate frozen slots on %s',
    (_name, draft, published, error) => {
      const source = slot(draft);
      const current = slot(published);
      const before = structuredClone({ source, current });
      const draftValues = draft.values;
      const publishedValues = published.values;
      freeze(source);
      freeze(current);
      const run = () => assertFreshPublishCompatibilityV2(source, current);
      if (error === null) expect(run()).toBeUndefined();
      else rejectsExactly(run, error);
      expect({ source, current }).toEqual(before);
      expect(source.document).toBe(draft);
      expect(current.document).toBe(published);
      expect(draft.values).toBe(draftValues);
      expect(published.values).toBe(publishedValues);
      expect(Object.isFrozen(draftValues)).toBe(true);
      expect(Object.isFrozen(publishedValues)).toBe(true);
    },
  );

  // Reflection probes are intentionally outside ordinary decoded JSON.
  describe.each([
    ['Error', new Error(upgrade)],
    ['TypeError', new TypeError('Expected a document shape V2')],
    ['non-Error', Object.freeze({ sentinel: true })],
  ])('unexpected %s propagation', (_name, sentinel) => {
    it.each(['Draft', 'Published'])(
      'preserves classifier failure identity from %s',
      (which) => {
        const document = new Proxy(production(), {
          getOwnPropertyDescriptor() {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional identity probe
            throw sentinel;
          },
        });
        const draft = which === 'Draft' ? document : production();
        const published = which === 'Published' ? document : production();
        throwsIdentity(
          () => assertFreshPublishCompatibilityV2(slot(draft), slot(published)),
          sentinel,
        );
      },
    );

    it.each(['Draft', 'Published'])(
      'preserves nested recognition failure identity from %s',
      (which) => {
        const document = {
          ...production(),
          values: new Proxy([], {
            getPrototypeOf() {
              // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional identity probe
              throw sentinel;
            },
          }),
        };
        const draft = which === 'Draft' ? document : production();
        const published = which === 'Published' ? document : production();
        throwsIdentity(
          () => assertFreshPublishCompatibilityV2(slot(draft), slot(published)),
          sentinel,
        );
      },
    );
  });
});
