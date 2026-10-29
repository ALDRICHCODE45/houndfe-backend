import { assertFreshCareCaptureV2 } from './editorial-care-capture-v2';
import {
  parseCareCaptureShapeV2,
  type CareReviewCaptureV2,
} from './editorial-care-capture-shape-v2';
import type { EvidenceV2 } from './editorial-evidence-v2';

type Prepared = Extract<CareReviewCaptureV2, { state: 'prepared' }>;
const evidence = { sourceRef: 'Manufacturer p. 2', verifiedOn: '2024-02-29' };
function requirement(key = 'r') {
  return {
    key,
    description: 'Requirement',
    disposition: 'unresolved' as const,
    evidence: [],
    basis: 'Basis',
  };
}
function warning(key = 'w') {
  return {
    key,
    requirementKeys: ['r'],
    text: 'Warning',
    disclosure: 'public_required' as const,
    evidence: [],
    handlingBasis: 'Basis',
  };
}
function review(): Prepared {
  return {
    state: 'prepared',
    jurisdiction: 'MX',
    intendedUse: 'Use',
    determination: 'identified',
    evidence: [],
    basis: 'Basis',
    requirements: [requirement()],
    warnings: [warning()],
  };
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function accepts(input: CareReviewCaptureV2) {
  const before = structuredClone(input);
  expect(assertFreshCareCaptureV2(freeze(input))).toBeUndefined();
  expect(input).toEqual(before);
}
function rejects(input: CareReviewCaptureV2) {
  const before = structuredClone(input);
  let failure: unknown;
  try {
    assertFreshCareCaptureV2(freeze(input));
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(Object.getPrototypeOf(failure)).toBe(Error.prototype);
  expect((failure as Error).message).toBe('MALFORMED');
  expect(input).toEqual(before);
}
const proseFields = [
  [
    'jurisdiction',
    200,
    (r: Prepared, s: string) => {
      r.jurisdiction = s;
    },
  ],
  [
    'intendedUse',
    1000,
    (r: Prepared, s: string) => {
      r.intendedUse = s;
    },
  ],
  [
    'basis',
    2000,
    (r: Prepared, s: string) => {
      r.basis = s;
    },
  ],
  [
    'requirement.key',
    80,
    (r: Prepared, s: string) => {
      r.requirements[0].key = s;
      r.warnings[0].requirementKeys = [s];
    },
  ],
  [
    'requirement.description',
    2000,
    (r: Prepared, s: string) => {
      r.requirements[0].description = s;
    },
  ],
  [
    'requirement.basis',
    2000,
    (r: Prepared, s: string) => {
      r.requirements[0].basis = s;
    },
  ],
  [
    'warning.key',
    80,
    (r: Prepared, s: string) => {
      r.warnings[0].key = s;
    },
  ],
  [
    'warning.text',
    4000,
    (r: Prepared, s: string) => {
      r.warnings[0].text = s;
    },
  ],
  [
    'warning.handlingBasis',
    2000,
    (r: Prepared, s: string) => {
      r.warnings[0].handlingBasis = s;
    },
  ],
] as const;

describe('assertFreshCareCaptureV2 capture only', () => {
  it('accepts frozen unknown and incomplete identified capture without approval', () => {
    accepts({ state: 'unknown' });
    const input = review();
    input.requirements = [];
    input.warnings = [];
    accepts(input);
  });
  it('accepts conflicting/unresolved requirements, public_required/unresolved warnings and none_applicable with entries', () => {
    const input = review();
    input.determination = 'none_applicable';
    input.requirements.push({
      ...requirement('other'),
      disposition: 'conflicting',
    });
    input.warnings.push({ ...warning('other'), disclosure: 'unresolved' });
    accepts(parseCareCaptureShapeV2(input));
  });
  describe.each(proseFields)('%s prose', (_name, maximum, set) => {
    function withText(text: string) {
      const input = review();
      set(input, text);
      return input;
    }
    it('accepts one/max codepoints, astral max and unchanged nonblank controls/whitespace', () => {
      for (const text of [
        'x',
        'x'.repeat(maximum),
        '😀'.repeat(maximum),
        ' \t\u0000\u001f\u007f x\r\n ',
      ])
        accepts(withText(text));
    });
    it('rejects max+1 codepoints, including astral', () => {
      rejects(withText('x'.repeat(maximum + 1)));
      rejects(withText('😀'.repeat(maximum + 1)));
    });
    it('rejects empty/ECMAScript-trim blank and both lone surrogate kinds', () => {
      for (const text of [
        '',
        ' \t\r\n\u2003\u00a0\ufeff',
        'x\ud800',
        '\udfff x',
      ])
        rejects(withText(text));
    });
  });
  describe.each(['requirements', 'warnings'] as const)(
    '%s collection',
    (field) => {
      it('accepts 32 and rejects 33 entries', () => {
        function sized(count: number) {
          const input = review();
          if (field === 'requirements') {
            input.requirements = Array.from({ length: count }, (_, i) =>
              requirement(`r${i}`),
            );
            input.warnings = [];
          } else
            input.warnings = Array.from({ length: count }, (_, i) =>
              warning(`w${i}`),
            );
          return input;
        }
        accepts(sized(32));
        rejects(sized(33));
      });
      it('rejects exact duplicate keys within its namespace', () => {
        const input = review();
        if (field === 'requirements') input.requirements.push(requirement());
        else input.warnings.push(warning());
        rejects(input);
      });
    },
  );
  it('keeps key namespaces separate and never trims or normalizes keys', () => {
    const input = review();
    input.requirements = ['same', ' same', 'é', 'e\u0301'].map(requirement);
    input.warnings = ['same', ' same', 'é', 'e\u0301'].map(warning);
    input.warnings.forEach((item) => {
      item.requirementKeys = ['e\u0301', ' same', 'é', 'same'];
    });
    accepts(input);
  });
  describe.each(['review', 'requirement', 'warning'] as const)(
    '%s evidence array',
    (position) => {
      function withEvidence(items: EvidenceV2[]) {
        const input = review();
        if (position === 'review') input.evidence = items;
        else if (position === 'requirement')
          input.requirements[0].evidence = items;
        else input.warnings[0].evidence = items;
        return input;
      }
      it('accepts empty/16 and rejects 17', () => {
        const items = Array.from({ length: 17 }, (_, i) => ({
          ...evidence,
          sourceRef: `Source ${i}`,
        }));
        accepts(withEvidence([]));
        accepts(withEvidence(items.slice(0, 16)));
        rejects(withEvidence(items));
      });
      it('rejects duplicate pairs but allows shared source/date separately and exact distinct strings', () => {
        rejects(withEvidence([evidence, { ...evidence }]));
        accepts(
          withEvidence([
            evidence,
            { ...evidence, verifiedOn: '2024-03-01' },
            { ...evidence, sourceRef: 'Other' },
            { ...evidence, sourceRef: ' Manufacturer p. 2' },
            { ...evidence, sourceRef: 'é' },
            { ...evidence, sourceRef: 'e\u0301' },
            { ...evidence, sourceRef: 'a|2024-02-29' },
            { ...evidence, sourceRef: 'a' },
          ]),
        );
      });
      it('uses real evidence predicate for every supplied locator/date, including invalid calendar dates', () => {
        for (const sourceRef of [
          '',
          ' \ufeff',
          'x\u0000',
          'x\u007f',
          '\ud800',
          'x'.repeat(1001),
        ]) {
          rejects(withEvidence([evidence, { ...evidence, sourceRef }]));
        }
        for (const verifiedOn of [
          '2023-02-29',
          '1900-02-29',
          '2024-04-31',
          '0000-01-01',
          '2024-2-29',
          '2024-02-29 ',
        ]) {
          rejects(withEvidence([evidence, { ...evidence, verifiedOn }]));
        }
        accepts(
          withEvidence([
            { sourceRef: ' 😀 '.repeat(100), verifiedOn: '2000-02-29' },
          ]),
        );
      });
    },
  );
  it('checks uniqueness locally, not across evidence arrays', () => {
    const input = review();
    input.evidence = [evidence];
    input.requirements[0].evidence = [evidence];
    input.warnings[0].evidence = [evidence];
    accepts(input);
  });
  it('accepts 32 forward-ordered references without reordering and empty references', () => {
    const input = review();
    input.requirements = Array.from({ length: 32 }, (_, i) =>
      requirement(`r${31 - i}`),
    );
    input.warnings[0].requirementKeys = Array.from(
      { length: 32 },
      (_, i) => `r${i}`,
    );
    accepts(input);
    const empty = review();
    empty.warnings[0].requirementKeys = [];
    accepts(empty);
  });
  it('rejects 33 references (coupled to the 32-requirement cap), duplicates and dangling/exact-mismatch references', () => {
    for (const keys of [
      Array.from({ length: 33 }, (_, i) => `r${i}`),
      ['r', 'r'],
      ['foreign'],
      [' r'],
      ['R'],
    ]) {
      const input = review();
      if (keys.length === 33) {
        input.requirements = Array.from({ length: 32 }, (_, i) =>
          requirement(`r${i}`),
        );
      }
      input.warnings[0].requirementKeys = keys;
      rejects(input);
    }
  });
  it('does not borrow a requirement from another review', () => {
    const other = review();
    other.requirements.push(requirement('foreign'));
    accepts(other);
    const input = review();
    input.warnings[0].requirementKeys = ['foreign'];
    rejects(input);
  });
});
