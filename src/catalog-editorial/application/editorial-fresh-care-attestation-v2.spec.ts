import { createHash } from 'node:crypto';
import {
  buildFreshCareAttestationV2 as build,
  type FreshCareAttestationInputV2,
} from './editorial-fresh-care-attestation-v2';
import type { SellableFactsShapeV2 } from '../domain/editorial-sellable-facts-shape-v2';
import * as readiness from '../domain/editorial-care-publication-readiness-v2';
import * as canonical from '../domain/editorial-canonical-json';

function row(variantId: string | null): SellableFactsShapeV2 {
  return {
    variantId,
    presentation: variantId === null ? 'Simple' : `Presentation ${variantId}`,
    declarations: [],
    careReview: {
      state: 'prepared',
      jurisdiction: 'MX',
      intendedUse: 'Use',
      determination: 'none_applicable',
      basis: 'Documented determination',
      evidence: [{ sourceRef: 'Manufacturer', verifiedOn: '2026-10-01' }],
      requirements: [],
      warnings: [],
    },
  };
}
function input(): FreshCareAttestationInputV2 {
  return {
    scope: { actorId: 'actor', tenantId: 'tenant', productId: 'product' },
    attempt: {
      cycle: 3,
      draftRevision: 7,
      publishedRevision: 11,
      vocabularyRevision: 'ev2-sha256-' + 'a'.repeat(64),
    },
    confirmedAt: '2026-10-31T12:34:56.789Z',
    document: {
      schemaVersion: 2,
      commercialTitle: null,
      description: null,
      mediaRefs: [],
      familyCode: 'care',
      values: [],
      facts: [row('a'), row('b')],
    },
    evaluationSubjects: ['a', 'b'],
    confirmation: 'review-v1',
  };
}
function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}
function reject(value: FreshCareAttestationInputV2): void {
  const before = JSON.stringify(value);
  freeze(value);
  let error: unknown;
  try {
    build(value);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
  expect((error as Error).message).toBe('MALFORMED');
  expect(JSON.stringify(value)).toBe(before);
}
afterEach(() => jest.restoreAllMocks());

it.each([{ evaluationSubjects: [] }, { evaluationSubjects: ['a'] }])(
  'requires care confirmation for E=$evaluationSubjects',
  ({ evaluationSubjects }) => {
    reject({ ...input(), evaluationSubjects, confirmation: null });
  },
);
it.each([null, 'hygiene', 'custom'])(
  'forbids care token for non-care family %p',
  (familyCode) => {
    const value = input();
    value.document.familyCode = familyCode;
    reject(value);
  },
);
it.each([null, 'hygiene', 'custom'])(
  'returns no audit for unconfirmed non-care %p',
  (familyCode) => {
    const value = input();
    value.document.familyCode = familyCode;
    value.confirmation = null;
    const check = jest.spyOn(readiness, 'assertCarePublicationReadinessV2');
    const hash = jest.spyOn(canonical, 'hashEditorialJson');
    freeze(value);
    expect(build(value)).toBeNull();
    expect(check).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
  },
);
it.each([null, 'review-v1'] as const)(
  'keeps non-care confirmation policy with empty E: %p',
  (confirmation) => {
    const value = input();
    value.document.familyCode = 'custom';
    value.document.facts = [];
    value.evaluationSubjects = [];
    value.confirmation = confirmation;
    if (confirmation === null) expect(build(value)).toBeNull();
    else reject(value);
  },
);
it('confirms empty E without inventing a subject or requiring inactive reviews', () => {
  const value = input();
  value.evaluationSubjects = [];
  value.document.facts = [{ ...row('inactive'), careReview: null }];
  const check = jest.spyOn(readiness, 'assertCarePublicationReadinessV2');
  expect(build(value)?.subjects).toEqual([]);
  expect(check).not.toHaveBeenCalled();
});
it('covers a real simple-null subject without substituting a variant', () => {
  const value = input();
  value.document.facts = [row('a'), row(null)];
  value.evaluationSubjects = [null];
  expect(build(value)?.subjects).toEqual([
    { variantId: null, presentation: 'Simple' },
  ]);
});
it.each([
  'missing',
  'null',
  'unknown',
  'later-invalid',
  'null-not-variant',
  'variant-not-null',
])('rejects incomplete exact-subject coverage: %s', (mode) => {
  const value = input();
  if (mode === 'missing') value.document.facts.pop();
  if (mode === 'null') value.document.facts[1].careReview = null;
  if (mode === 'unknown')
    value.document.facts[1].careReview = { state: 'unknown' };
  if (mode === 'later-invalid') {
    const review = value.document.facts[1].careReview!;
    if (review.state === 'prepared') review.evidence = [];
  }
  if (mode === 'null-not-variant') {
    value.document.facts = [row(null)];
    value.evaluationSubjects = ['a'];
  }
  if (mode === 'variant-not-null') {
    value.document.facts = [row('a')];
    value.evaluationSubjects = [null];
  }
  reject(value);
});
it('projects exactly E in original facts order, not E or lexical order', () => {
  const value = input();
  value.document.facts = [
    row('z'),
    { ...row('inactive'), careReview: { state: 'unknown' } },
    row('a'),
  ];
  value.evaluationSubjects = ['a', 'z'];
  const check = jest.spyOn(readiness, 'assertCarePublicationReadinessV2');
  expect(build(value)?.subjects).toEqual([
    { variantId: 'z', presentation: 'Presentation z' },
    { variantId: 'a', presentation: 'Presentation a' },
  ]);
  expect(check.mock.calls).toEqual([
    [value.document.facts[0].careReview],
    [value.document.facts[2].careReview],
  ]);
});
it('copies exact server metadata and excludes private review fields from subjects', () => {
  const value = input();
  const result = build(value);
  expect(result).toEqual({
    actorId: 'actor',
    tenantId: 'tenant',
    productId: 'product',
    confirmedAt: '2026-10-31T12:34:56.789Z',
    cycle: 3,
    draftRevision: 7,
    publishedRevision: 11,
    vocabularyRevision: 'ev2-sha256-' + 'a'.repeat(64),
    documentDigest: expect.stringMatching(
      /^ecd2-sha256-[0-9a-f]{64}$/,
    ) as string,
    subjects: [
      { variantId: 'a', presentation: 'Presentation a' },
      { variantId: 'b', presentation: 'Presentation b' },
    ],
  });
});
it('hashes the exact canonical preimage against an independent literal oracle', () => {
  const value = input();
  value.document.facts = [];
  value.evaluationSubjects = [];
  const literal =
    '{"cycle":3,"document":{"commercialTitle":null,"description":null,"facts":[],"familyCode":"care","mediaRefs":[],"schemaVersion":2,"values":[]},"draftRevision":7}';
  const expected =
    'ecd2-sha256-' + createHash('sha256').update(literal, 'utf8').digest('hex');
  expect(build(value)?.documentDigest).toBe(expected);
});
it('ignores object-key insertion order without normalizing document arrays', () => {
  const original = input();
  function reverseKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(reverseKeys);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .reverse()
          .map(([key, nested]) => [key, reverseKeys(nested)]),
      );
    return value;
  }
  const reordered = {
    ...original,
    document: reverseKeys(
      original.document,
    ) as FreshCareAttestationInputV2['document'],
  };
  expect(build(reordered)).toEqual(build(original));
});
it.each(['facts', 'media', 'values', 'review-evidence'])(
  'preserves %s array order in the digest',
  (collection) => {
    const value = input();
    value.document.mediaRefs = ['asset-b', 'asset-a'];
    value.document.values = ['b', 'a'].map((code) => ({
      code,
      owner: 'product',
      variantId: null,
      state: 'unknown',
      evidence: null,
    }));
    const review = value.document.facts[0].careReview!;
    if (review.state === 'prepared')
      review.evidence.push({ sourceRef: 'Second', verifiedOn: '2026-10-02' });
    const before = build(value)!;
    if (collection === 'facts') value.document.facts.reverse();
    if (collection === 'media') value.document.mediaRefs.reverse();
    if (collection === 'values') value.document.values.reverse();
    if (collection === 'review-evidence' && review.state === 'prepared')
      review.evidence.reverse();
    expect(build(value)?.documentDigest).not.toBe(before.documentDigest);
  },
);
it('includes inactive facts in the digest while excluding them from coverage and subjects', () => {
  const value = input();
  value.document.facts.push({ ...row('inactive'), careReview: null });
  const before = build(value)!;
  value.document.facts[2].presentation = 'Changed inactive presentation';
  const after = build(value)!;
  expect(after.subjects).toEqual(before.subjects);
  expect(after.documentDigest).not.toBe(before.documentDigest);
});
it.each(['cycle', 'draftRevision'] as const)(
  'includes %s in the digest',
  (key) => {
    const value = input();
    const before = build(value)!;
    value.attempt[key]++;
    expect(build(value)?.documentDigest).not.toBe(before.documentDigest);
  },
);
it('does not add audit metadata or E order to the document digest', () => {
  const value = input();
  const before = build(value)!;
  value.scope = {
    actorId: 'other actor',
    tenantId: 'other tenant',
    productId: 'other product',
  };
  value.confirmedAt = '2026-11-01T00:00:00.000Z';
  value.attempt.publishedRevision++;
  value.attempt.vocabularyRevision = 'ev2-sha256-' + 'b'.repeat(64);
  value.evaluationSubjects = ['b', 'a'];
  const after = build(value)!;
  expect(after.documentDigest).toBe(before.documentDigest);
  expect(after.subjects).toEqual(before.subjects);
  expect(after).toMatchObject({
    ...value.scope,
    ...value.attempt,
    confirmedAt: value.confirmedAt,
  });
});
it('preserves frozen inputs and returns fresh detached subject projections', () => {
  const value = input();
  const before = JSON.stringify(value);
  freeze(value);
  const result = build(value)!;
  result.subjects[0].presentation = 'Changed returned value';
  result.subjects.push({ variantId: 'extra', presentation: 'Extra' });
  result.actorId = 'changed';
  expect(JSON.stringify(value)).toBe(before);
  expect(build(value)?.subjects).toEqual([
    { variantId: 'a', presentation: 'Presentation a' },
    { variantId: 'b', presentation: 'Presentation b' },
  ]);
});
it.each(['readiness', 'hash'])(
  'propagates unexpected %s errors unchanged',
  (dependency) => {
    const sentinel = new RangeError('dependency failure');
    if (dependency === 'readiness')
      jest
        .spyOn(readiness, 'assertCarePublicationReadinessV2')
        .mockImplementation(() => {
          throw sentinel;
        });
    else
      jest.spyOn(canonical, 'hashEditorialJson').mockImplementation(() => {
        throw sentinel;
      });
    let caught: unknown;
    try {
      build(input());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(sentinel);
  },
);
