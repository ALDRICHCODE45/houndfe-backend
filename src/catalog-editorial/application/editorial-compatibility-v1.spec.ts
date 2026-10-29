import type { EditorialDocumentJson } from '../domain/editorial-document-mode';
import type { VocabularyReadSnapshot } from '../domain/editorial-vocabulary-projection-v1';
import { assertEditorialCompatibilityV1 as assertCompatible } from './editorial-compatibility-v1';

const production = {
  schemaVersion: 2,
  commercialTitle: null,
  description: null,
  mediaRefs: [],
  familyCode: null,
  values: [],
  facts: [],
};
const vocabulary: Pick<VocabularyReadSnapshot, 'families'> = {
  families: [
    {
      id: 'old',
      code: 'legacy.custom',
      label: '',
      minimumContractVersion: 1,
      bindings: [],
    },
    {
      id: 'new',
      code: 'arbitrary.custom',
      label: '',
      minimumContractVersion: 2,
      bindings: [],
    },
  ],
};
const absent = () => ({ draft: null, published: null });
const slot = (document: EditorialDocumentJson) => ({ document });
function rejects(run: () => void): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(Object.getPrototypeOf(caught)).toBe(Error.prototype);
  expect((caught as Error).message).toBe('EDITORIAL_CLIENT_UPGRADE_REQUIRED');
  expect(Object.keys(caught as Error)).toEqual([]);
}

describe('assertEditorialCompatibilityV1', () => {
  it.each(['draft', 'published', 'both'] as const)(
    'protects %s independently of candidate family',
    (target) => {
      for (const document of [
        production,
        { schemaVersion: 3 },
        { schemaVersion: 2 },
      ]) {
        const state = {
          draft: target !== 'published' ? slot(document) : null,
          published: target !== 'draft' ? slot(document) : null,
        };
        for (const family of [null, 'legacy.custom', 'missing'])
          rejects(() => assertCompatible(state, family, vocabulary));
      }
    },
  );

  it('protects an arbitrary V2 family using complete metadata even with absent slots', () => {
    rejects(() => assertCompatible(absent(), 'arbitrary.custom', vocabulary));
  });

  it.each([null, 'legacy.custom', 'missing', '', 'ARBITRARY.CUSTOM'])(
    'does not infer an upgrade requirement for candidate %p',
    (family) => {
      expect(assertCompatible(absent(), family, vocabulary)).toBeUndefined();
    },
  );

  it.each<EditorialDocumentJson>([
    null,
    {},
    { values: 'malformed legacy' },
    false,
    4,
    'old',
    [],
  ])('does not freshly validate unversioned history %p', (document) => {
    expect(
      assertCompatible(
        { draft: slot(document), published: slot(document) },
        null,
        vocabulary,
      ),
    ).toBeUndefined();
    rejects(() =>
      assertCompatible(
        { draft: slot(document), published: null },
        'arbitrary.custom',
        vocabulary,
      ),
    );
  });

  it('looks at the selected family version rather than names or unrelated advanced families', () => {
    const changed = {
      families: vocabulary.families.map((family) => ({
        ...family,
        minimumContractVersion:
          family.minimumContractVersion === 1 ? (2 as const) : (1 as const),
      })),
    };
    rejects(() => assertCompatible(absent(), 'legacy.custom', changed));
    expect(
      assertCompatible(absent(), 'arbitrary.custom', changed),
    ).toBeUndefined();
  });

  it('preserves frozen inputs on success and both rejection paths', () => {
    const document = { old: ['\ud800', -0] };
    const state = { draft: slot(document), published: slot(document) };
    function freeze(value: unknown): void {
      if (value && typeof value === 'object') {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
      }
    }
    const before = structuredClone({ state, vocabulary });
    freeze(state);
    freeze(vocabulary);
    expect(
      assertCompatible(state, 'legacy.custom', vocabulary),
    ).toBeUndefined();
    rejects(() => assertCompatible(state, 'arbitrary.custom', vocabulary));
    const advanced = { draft: slot(production), published: state.published };
    freeze(advanced);
    rejects(() => assertCompatible(advanced, null, vocabulary));
    expect({ state, vocabulary }).toEqual(before);
    expect(state.draft.document).toBe(document);
    expect(Object.is(document.old[1], -0)).toBe(true);
    expect(advanced.draft.document).toBe(production);
  });

  it.each([
    new Error('reflection'),
    new TypeError('EDITORIAL_CLIENT_UPGRADE_REQUIRED'),
    'sentinel',
  ])('propagates classifier failures unchanged: %p', (sentinel) => {
    for (const target of ['draft', 'published']) {
      const document = new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- Probe arbitrary reflection failure identity.
            throw sentinel;
          },
        },
      );
      const state = { ...absent(), [target]: slot(document) };
      let caught: unknown;
      try {
        assertCompatible(state, null, vocabulary);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(sentinel);
    }
  });
});
