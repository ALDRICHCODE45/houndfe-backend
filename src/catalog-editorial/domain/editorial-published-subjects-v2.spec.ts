import {
  coversPublishedSubjectV2,
  decodePublishedSubjectsV2,
} from './editorial-published-subjects-v2';

describe('published subjects V2', () => {
  it('decodes a recorded array of variant ids and the product presentation', () => {
    expect(decodePublishedSubjectsV2(['v-1', 'v-2'])).toEqual(['v-1', 'v-2']);
    expect(decodePublishedSubjectsV2([null])).toEqual([null]);
    expect(decodePublishedSubjectsV2([])).toEqual([]);
  });

  it('keeps an unrecorded publication (null) distinct from an empty one', () => {
    expect(decodePublishedSubjectsV2(null)).toBeNull();
  });

  it.each([
    { input: {} },
    { input: 'v-1' },
    { input: [1] },
    { input: [''] },
    { input: ['v-1', 'v-1'] },
    { input: [null, null] },
  ])('rejects the malformed recording $input', ({ input }) => {
    expect(() => decodePublishedSubjectsV2(input)).toThrow(TypeError);
  });

  it('covers only recorded subjects of a current Published revision', () => {
    const coverage = { publishedRevision: 3, subjects: ['v-1'] };
    expect(coversPublishedSubjectV2(coverage, 'v-1')).toBe(true);
    expect(coversPublishedSubjectV2(coverage, 'v-2')).toBe(false);
    expect(coversPublishedSubjectV2(coverage, null)).toBe(false);
    const simple = { publishedRevision: 1, subjects: [null] };
    expect(coversPublishedSubjectV2(simple, null)).toBe(true);
    expect(coversPublishedSubjectV2(simple, 'v-1')).toBe(false);
  });

  it('an unrecorded publication covers every subject; no Published covers none', () => {
    const legacy = { publishedRevision: 2, subjects: null };
    expect(coversPublishedSubjectV2(legacy, 'v-9')).toBe(true);
    expect(coversPublishedSubjectV2(legacy, null)).toBe(true);
    expect(coversPublishedSubjectV2(null, 'v-1')).toBe(false);
    expect(coversPublishedSubjectV2(undefined, null)).toBe(false);
  });
});
