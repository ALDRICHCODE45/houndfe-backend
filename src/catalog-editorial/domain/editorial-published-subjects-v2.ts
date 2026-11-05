/**
 * Offered subjects E a Published version covered, recorded at publish time:
 * variant ids, or null for the simple-product presentation. `subjects: null`
 * is a publication without a recording (published before recording existed,
 * or written outside the publish writer) and covers every subject.
 */
export type PublishedCoverageV2 = {
  readonly publishedRevision: number;
  readonly subjects: readonly (string | null)[] | null;
};

function invalid(): never {
  throw new TypeError('Expected recorded published subjects V2');
}

/** Stored column value: a duplicate-free array of non-empty ids/null, or null. */
export function decodePublishedSubjectsV2(
  input: unknown,
): (string | null)[] | null {
  if (input === null) return null;
  if (!Array.isArray(input)) invalid();
  const subjects = input.map((subject: unknown): string | null => {
    if (subject === null || (typeof subject === 'string' && subject !== ''))
      return subject;
    invalid();
  });
  if (new Set(subjects).size !== subjects.length) invalid();
  return subjects;
}

/** «Is subject X covered by the current Published revision?» */
export function coversPublishedSubjectV2(
  coverage: PublishedCoverageV2 | null | undefined,
  variantId: string | null,
): boolean {
  if (!coverage) return false;
  return coverage.subjects === null || coverage.subjects.includes(variantId);
}
