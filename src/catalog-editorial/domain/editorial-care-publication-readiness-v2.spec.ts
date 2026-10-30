import * as capture from './editorial-care-capture-v2';
import type { CareReviewCaptureV2 } from './editorial-care-capture-shape-v2';
import type {
  CareRequirementV2,
  CareWarningV2,
} from './editorial-care-entry-shape-v2';
import { assertCarePublicationReadinessV2 } from './editorial-care-publication-readiness-v2';

type Prepared = Extract<CareReviewCaptureV2, { state: 'prepared' }>;
const evidence = () => [
  { sourceRef: 'manufacturer document', verifiedOn: '2026-10-01' },
];
const requirement = (
  disposition: CareRequirementV2['disposition'] = 'satisfied',
  key = 'r1',
): CareRequirementV2 => ({
  key,
  description: 'Applicable requirement',
  disposition,
  evidence: evidence(),
  basis: 'Reviewed supporting documentation',
});
const warning = (
  disclosure: CareWarningV2['disclosure'] = 'private_only',
  key = 'w1',
): CareWarningV2 => ({
  key,
  requirementKeys: ['r1'],
  text: 'Private review note',
  disclosure,
  evidence: evidence(),
  handlingBasis: 'Documented private treatment',
});
function prepared(): Prepared {
  return {
    state: 'prepared',
    jurisdiction: 'Declared jurisdiction',
    intendedUse: 'Declared use',
    determination: 'identified',
    basis: 'Documented determination',
    evidence: evidence(),
    requirements: [requirement()],
    warnings: [],
  };
}
function freeze(input: unknown): void {
  if (input !== null && typeof input === 'object') {
    Object.values(input).forEach(freeze);
    Object.freeze(input);
  }
}
function check(review: CareReviewCaptureV2 | null | undefined): void {
  const before = structuredClone(review);
  freeze(review);
  try {
    assertCarePublicationReadinessV2(review);
  } finally {
    expect(review).toEqual(before);
  }
}
function reject(review: CareReviewCaptureV2 | null | undefined): void {
  let caught: unknown;
  try {
    check(review);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toBe('MALFORMED');
}

describe('care review publication readiness', () => {
  it.each([undefined, null, { state: 'unknown' } as const])(
    'rejects absent or unknown review %j',
    reject,
  );

  it('requires evidence on the review itself', () => {
    const review = prepared();
    review.evidence = [];
    expect(() => capture.assertFreshCareCaptureV2(review)).not.toThrow();
    reject(review);
  });

  it('requires an identified requirement rather than only a ready label', () => {
    const review = prepared();
    review.requirements = [];
    reject(review);
  });

  it.each(['unresolved', 'conflicting'] as const)(
    'rejects %s requirement even after a valid one',
    (disposition) => {
      const review = prepared();
      review.requirements.push(requirement(disposition, 'r2'));
      expect(() => capture.assertFreshCareCaptureV2(review)).not.toThrow();
      reject(review);
    },
  );

  it.each(['satisfied', 'not_applicable'] as const)(
    '%s requirements need their own evidence',
    (disposition) => {
      const review = prepared();
      review.requirements = [{ ...requirement(disposition), evidence: [] }];
      reject(review);
    },
  );

  it.each(['satisfied', 'not_applicable'] as const)(
    'accepts an evidenced %s requirement',
    (disposition) => {
      const review = prepared();
      review.requirements = [requirement(disposition)];
      expect(check(review)).toBeUndefined();
    },
  );

  it('accepts evidenced none_applicable with no entries', () => {
    const review = prepared();
    review.determination = 'none_applicable';
    review.requirements = [];
    expect(check(review)).toBeUndefined();
  });

  it.each(['requirements', 'warnings'] as const)(
    'none_applicable rejects nonempty %s',
    (collection) => {
      const review = prepared();
      review.determination = 'none_applicable';
      review.requirements = [];
      if (collection === 'requirements')
        review.requirements.push(requirement());
      else review.warnings.push({ ...warning(), requirementKeys: [] });
      expect(() => capture.assertFreshCareCaptureV2(review)).not.toThrow();
      reject(review);
    },
  );

  it('none_applicable still needs review evidence and explanation', () => {
    const review = prepared();
    review.determination = 'none_applicable';
    review.requirements = [];
    reject({ ...review, evidence: [] });
    reject({ ...review, basis: '  ' });
  });

  it.each(['unresolved', 'public_required'] as const)(
    'rejects %s warning even with evidence',
    (disclosure) => {
      const review = prepared();
      review.warnings = [warning(), warning(disclosure, 'w2')];
      expect(() => capture.assertFreshCareCaptureV2(review)).not.toThrow();
      reject(review);
    },
  );

  it('requires each private warning to have evidence', () => {
    const review = prepared();
    review.warnings = [
      warning(),
      { ...warning('private_only', 'w2'), evidence: [] },
    ];
    reject(review);
  });

  it('accepts multiple evidenced requirements and private warnings without mutation', () => {
    const review = prepared();
    review.requirements.push(requirement('not_applicable', 'r2'));
    review.warnings = [
      warning(),
      { ...warning('private_only', 'w2'), requirementKeys: ['r1', 'r2'] },
    ];
    expect(check(review)).toBeUndefined();
    expect(check(review)).toBeUndefined();
  });

  it.each(['jurisdiction', 'intendedUse', 'basis'] as const)(
    'retains fresh capture nonblank %s checks',
    (key) => {
      const review = prepared();
      review[key] = ' \t ';
      reject(review);
    },
  );

  it.each(['review', 'requirement', 'warning'] as const)(
    'rejects malformed evidence on %s',
    (target) => {
      const review = prepared();
      review.warnings = [warning()];
      const items =
        target === 'review'
          ? review.evidence
          : target === 'requirement'
            ? review.requirements[0].evidence
            : review.warnings[0].evidence;
      items[0].verifiedOn = '2026-02-30';
      reject(review);
    },
  );

  it('retains requirement basis and warning handling basis checks', () => {
    const badRequirement = prepared();
    badRequirement.requirements[0].basis = ' ';
    reject(badRequirement);
    const badWarning = prepared();
    badWarning.warnings = [{ ...warning(), handlingBasis: ' ' }];
    reject(badWarning);
  });

  it('retains warning reference validity', () => {
    const review = prepared();
    review.warnings = [{ ...warning(), requirementKeys: ['missing'] }];
    reject(review);
  });

  it('preserves unexpected capture dependency errors by identity', () => {
    const sentinel = new Error('unexpected capture failure');
    const spy = jest
      .spyOn(capture, 'assertFreshCareCaptureV2')
      .mockImplementation(() => {
        throw sentinel;
      });
    let caught: unknown;
    try {
      check(prepared());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(sentinel);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
