import type { FactInputsV2 } from './editorial-fact-rule-evaluation-v2';
import { assertToyDeterminationAgreementV2 } from './editorial-toy-determination-agreement-v2';

type Determination = NonNullable<FactInputsV2['relevantDimensionCodes']>;
const ball = 'toy.type.ball';
const chew = 'toy.type.chew';
const rope = 'toy.type.rope';
const length = 'measure.dimensions.external_length';
const diameter = 'measure.dimensions.external_diameter';

function dimension(
  toyTypes: string[],
  codes: string[] = [length],
): Determination {
  return { codes, toyTypes };
}
function freeze(input: unknown): void {
  if (input !== null && typeof input === 'object') {
    Object.values(input).forEach(freeze);
    Object.freeze(input);
  }
}
function check(
  selected: readonly string[],
  determination: Determination | null | undefined,
): void {
  const before = structuredClone({ selected, determination });
  freeze(selected);
  freeze(determination);
  try {
    assertToyDeterminationAgreementV2(selected, determination);
  } finally {
    expect({ selected, determination }).toEqual(before);
  }
}
function reject(
  selected: readonly string[],
  determination: Determination | null | undefined,
): void {
  let caught: unknown;
  try {
    check(selected, determination);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(Object.getPrototypeOf(caught)).toBe(Error.prototype);
  expect((caught as Error).message).toBe('MALFORMED');
  expect(Object.keys(caught as Error)).toEqual([]);
}

describe('toy determination agreement for one selected subject', () => {
  it.each([undefined, null])(
    'rejects missing or unknown qualified determination %j',
    (determination) => reject([ball], determination),
  );

  it('accepts one exactly covered selected type', () => {
    expect(() => check([ball], dimension([ball]))).not.toThrow();
  });

  it('accepts several exactly covered selected types', () => {
    expect(() =>
      check([ball, chew, rope], dimension([ball, chew, rope])),
    ).not.toThrow();
  });

  it('accepts a reordered determination without sorting either input', () => {
    expect(() =>
      check([ball, chew, rope], dimension([rope, ball, chew])),
    ).not.toThrow();
  });

  it('accepts a reordered selection without requiring determination order', () => {
    expect(() =>
      check([rope, chew, ball], dimension([ball, chew, rope])),
    ).not.toThrow();
  });

  it.each<[string, string[]]>([
    ['empty coverage', []],
    ['only the first selected use', [ball]],
    ['only the last selected use', [rope]],
    ['a proper subset', [ball, rope]],
  ])('rejects %s', (_label, covered) => {
    reject([ball, chew, rope], dimension(covered));
  });

  it.each<[string, string[]]>([
    ['extra type after the match', [ball, chew]],
    ['extra type before the match', [chew, ball]],
    ['several extra types', [rope, ball, chew]],
  ])('rejects a superset: %s', (_label, covered) => {
    reject([ball], dimension(covered));
  });

  it('rejects equal cardinality with different singleton membership', () => {
    reject([ball], dimension([chew]));
  });

  it('rejects equal cardinality with only partial overlap', () => {
    reject([ball, chew], dimension([ball, rope]));
  });

  it('checks later membership rather than accepting a shared prefix', () => {
    reject([ball, chew, rope], dimension([ball, chew, 'toy.type.plush']));
  });

  it('does not waive missing type coverage when axes are empty', () => {
    reject([ball, chew], dimension([ball], []));
  });

  it('does not waive extra type coverage when axes are empty', () => {
    reject([ball], dimension([ball, chew], []));
  });

  it('does not waive equal-size membership disagreement when axes are empty', () => {
    reject([ball, chew], dimension([ball, rope], []));
  });

  it('does not waive wholly empty coverage when axes are empty', () => {
    reject([ball], dimension([], []));
  });

  it('accepts a qualified human negative determination for all selected uses', () => {
    // Qualification already established evidence/basis for this empty axis set.
    expect(() =>
      check([ball, chew], dimension([chew, ball], [])),
    ).not.toThrow();
  });

  it.each([
    { codes: [length] },
    { codes: [diameter] },
    { codes: [diameter, length] },
  ])(
    'does not infer a type-to-axis taxonomy for qualified axes $codes',
    ({ codes }) => {
      expect(() =>
        check([ball, chew], dimension([chew, ball], codes)),
      ).not.toThrow();
    },
  );

  it('does not let more named axes compensate for an uncovered type', () => {
    reject([ball, chew], dimension([ball], [length, diameter]));
  });

  it('retains frozen selected and determination order on successful agreement', () => {
    const selected = [rope, ball, chew];
    const determination = dimension([chew, rope, ball], [diameter, length]);
    expect(() => check(selected, determination)).not.toThrow();
    expect(selected).toEqual([rope, ball, chew]);
    expect(determination).toEqual({
      toyTypes: [chew, rope, ball],
      codes: [diameter, length],
    });
  });

  it('retains frozen arrays on rejected agreement', () => {
    const selected = [rope, ball];
    const determination = dimension([chew, rope], [diameter, length]);
    reject(selected, determination);
    expect(selected).toEqual([rope, ball]);
    expect(determination).toEqual({
      toyTypes: [chew, rope],
      codes: [diameter, length],
    });
  });

  it('checks each supplied subject independently without carrying prior coverage', () => {
    expect(() => check([ball], dimension([ball]))).not.toThrow();
    reject([chew], dimension([ball]));
    expect(() => check([chew], dimension([chew]))).not.toThrow();
    reject([ball], undefined);
  });
});
