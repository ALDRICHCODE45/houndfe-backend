import type { DocumentShapeV2 } from './editorial-document-shape-v2';
import { assertFreshDocumentLimitsV2 as assertLimits } from './editorial-document-limits-v2';

function document(): DocumentShapeV2 {
  return {
    schemaVersion: 2,
    commercialTitle: 'Title',
    description: null,
    mediaRefs: [],
    familyCode: null,
    values: [],
    facts: [],
  };
}
function reject(candidate: DocumentShapeV2, operation: 'save' | 'publish') {
  let caught: unknown;
  try {
    assertLimits(candidate, operation);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(Object.getPrototypeOf(caught)).toBe(Error.prototype);
  expect((caught as Error).message).toBe('MALFORMED');
}

describe.each(['save', 'publish'] as const)(
  'fresh %s ordinary limits',
  (operation) => {
    it.each([
      ['commercialTitle', 200],
      ['description', 20000],
    ] as const)('counts %s in Unicode code points up to %i', (key, max) => {
      for (const character of ['x', '😀']) {
        const candidate = { ...document(), [key]: character.repeat(max) };
        expect(assertLimits(candidate, operation)).toBeUndefined();
        reject({ ...candidate, [key]: character.repeat(max + 1) }, operation);
      }
    });
    it('accepts null description without applying fact-string policies', () => {
      expect(assertLimits(document(), operation)).toBeUndefined();
      const candidate = {
        ...document(),
        commercialTitle: ' \ud800\u0000 ',
        description: '\ud800\u0000',
      };
      expect(assertLimits(candidate, operation)).toBeUndefined();
      expect(candidate.commercialTitle).toBe(' \ud800\u0000 ');
    });
    it.each(['values', 'facts'] as const)(
      'caps %s independently at 200',
      (key) => {
        const candidate = document();
        if (key === 'values')
          candidate.values = Array.from({ length: 200 }, (_, index) => ({
            code: `code-${index}`,
            owner: 'product',
            variantId: null,
            state: 'unknown',
            evidence: null,
          }));
        else
          candidate.facts = Array.from({ length: 200 }, (_, index) => ({
            variantId: `variant-${index}`,
            presentation: '',
            declarations: [],
            careReview: null,
          }));
        expect(assertLimits(candidate, operation)).toBeUndefined();
        if (key === 'values') candidate.values.push(candidate.values[0]);
        else candidate.facts.push(candidate.facts[0]);
        reject(candidate, operation);
      },
    );
    it('does not impose a separate text-payload or serialized-body limit', () => {
      const candidate = document();
      candidate.values = [
        {
          code: 'text',
          owner: 'product',
          variantId: null,
          state: 'known',
          evidence: null,
          payload: { type: 'text', value: 'x'.repeat(110000) },
        },
      ];
      expect(assertLimits(candidate, operation)).toBeUndefined();
    });
  },
);

describe('save versus publish minimums', () => {
  it.each([null, '', '   ', '\t\r\n', '\u00a0\ufeff\u2028'])(
    'allows title %p on save, not publish',
    (commercialTitle) => {
      const candidate = { ...document(), commercialTitle };
      expect(assertLimits(candidate, 'save')).toBeUndefined();
      reject(candidate, 'publish');
    },
  );
  it('preserves nonblank titles verbatim, including whitespace not removed by ECMAScript trim', () => {
    for (const commercialTitle of ['  Title\n', '\u200b']) {
      const candidate = { ...document(), commercialTitle };
      expect(assertLimits(candidate, 'publish')).toBeUndefined();
      expect(candidate.commercialTitle).toBe(commercialTitle);
    }
  });
  it('allows 20 media IDs on save but rejects any media on publish', () => {
    const candidate = {
      ...document(),
      mediaRefs: Array.from({ length: 20 }, (_, index) => `asset-${index}`),
    };
    expect(assertLimits(candidate, 'save')).toBeUndefined();
    reject(
      { ...candidate, mediaRefs: [...candidate.mediaRefs, 'extra'] },
      'save',
    );
    for (const mediaRefs of [['one'], candidate.mediaRefs])
      reject({ ...candidate, mediaRefs }, 'publish');
    expect(assertLimits(document(), 'publish')).toBeUndefined();
  });
  it('leaves frozen inputs unchanged on success and rejection', () => {
    const candidate = document();
    Object.freeze(candidate.mediaRefs);
    Object.freeze(candidate.values);
    Object.freeze(candidate.facts);
    Object.freeze(candidate);
    expect(assertLimits(candidate, 'publish')).toBeUndefined();
    const invalid = Object.freeze({
      ...candidate,
      commercialTitle: ' '.repeat(201),
    });
    for (const operation of ['save', 'publish'] as const)
      reject(invalid, operation);
    expect(candidate).toEqual(document());
    expect(invalid.commercialTitle).toBe(' '.repeat(201));
  });
});
