import { parseDeclarationShapeV2 } from './editorial-declaration-shape-v2';
import { assertFreshFactsCaptureV2 } from './editorial-facts-capture-v2';
import {
  parseSellableFactsShapeV2,
  type SellableFactsShapeV2,
} from './editorial-sellable-facts-shape-v2';

const evidence = { sourceRef: 'Manufacturer p. 2', verifiedOn: '2024-02-29' };
const examples = [
  ['contentMagnitude', 'mass'],
  ['consumable', false],
  ['animalApplied', false],
  ['fitDeterminesChoice', false],
  ['capacityDeterminesChoice', false],
  ['electricalApplies', false],
  ['relevantDimensionCodes', { codes: [], toyTypes: [] }],
  ['relevantFitCodes', []],
  ['relevantCapacityCodes', []],
  ['relevantEquipmentCodes', []],
  ['presentationKind', 'device'],
  ['optionalNonpertinenceCodes', []],
] as const;

function known(
  key: string,
  value: unknown,
  basis = 'Manufacturer determination',
) {
  return parseDeclarationShapeV2({
    key,
    state: 'known',
    value,
    basis,
    evidence,
  });
}
function row(declarations: SellableFactsShapeV2['declarations'] = []) {
  return parseSellableFactsShapeV2({
    variantId: null,
    presentation: 'Package',
    declarations,
    careReview: null,
  });
}
function rejects(input: SellableFactsShapeV2) {
  let failure: unknown;
  try {
    assertFreshFactsCaptureV2(input);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(Object.getPrototypeOf(failure)).toBe(Error.prototype);
  expect((failure as Error).message).toBe('MALFORMED');
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

describe('assertFreshFactsCaptureV2', () => {
  it('accepts empty declarations and explicit unknowns without changing them', () => {
    const input = row(
      examples.map(([key]) =>
        parseDeclarationShapeV2({ key, state: 'unknown', evidence: null }),
      ),
    );
    const before = structuredClone(input);
    expect(assertFreshFactsCaptureV2(input)).toBeUndefined();
    expect(input).toEqual(before);
    expect(assertFreshFactsCaptureV2(row())).toBeUndefined();
  });

  it('accepts all twelve unique known keys, including false and empty values', () => {
    const input = row(examples.map(([key, value]) => known(key, value)));
    expect(assertFreshFactsCaptureV2(input)).toBeUndefined();
  });

  describe.each(examples)('%s known capture', (key, value) => {
    it('requires valid evidence and basis even for false or empty values', () => {
      expect(
        assertFreshFactsCaptureV2(row([known(key, value)])),
      ).toBeUndefined();
      const badEvidence = row([known(key, value)]);
      const declaration = badEvidence.declarations[0];
      if (declaration.state !== 'known') throw new Error('fixture');
      declaration.evidence.verifiedOn = '2023-02-29';
      rejects(badEvidence);
      rejects(row([known(key, value, '\u2003\u00a0\ufeff')]));
    });
  });

  describe.each([
    ['presentation', 300],
    ['basis', 2000],
  ] as const)('%s prose', (field, maximum) => {
    function withText(text: string) {
      const input = row([known('consumable', false, text)]);
      if (field === 'presentation') {
        input.presentation = text;
        input.declarations = [];
      }
      return input;
    }
    it.each(['x', '😀'])(
      'counts %s by Unicode code points at 1, max and max+1',
      (character) => {
        expect(assertFreshFactsCaptureV2(withText(character))).toBeUndefined();
        expect(
          assertFreshFactsCaptureV2(withText(character.repeat(maximum))),
        ).toBeUndefined();
        rejects(withText(character.repeat(maximum + 1)));
      },
    );
    it.each([
      '',
      ' \t\r\n',
      '\u2003\u00a0\ufeff',
      '\ud800',
      '\udfff',
      'a\ud800b',
      'a\udfffb',
    ])('rejects blank or isolated surrogates %j', (text) => {
      rejects(withText(text));
    });
    it('preserves spaces, paired surrogates and nonblank C0/DEL prose', () => {
      const input = withText('  \u0000\u001f\u007f😀  ');
      const before = structuredClone(input);
      expect(assertFreshFactsCaptureV2(input)).toBeUndefined();
      expect(input).toEqual(before);
    });
  });

  it.each(['known', 'unknown'] as const)(
    'rejects duplicate keys across known/%s branches',
    (state) => {
      const duplicate =
        state === 'known'
          ? known('consumable', true)
          : parseDeclarationShapeV2({
              key: 'consumable',
              state,
              evidence: null,
            });
      rejects(row([known('consumable', false), duplicate]));
    },
  );
  it('rejects duplicate unknown keys', () => {
    const unknown = parseDeclarationShapeV2({
      key: 'animalApplied',
      state: 'unknown',
      evidence: null,
    });
    rejects(row([unknown, unknown]));
  });
  it('rejects thirteen declarations (necessarily also a duplicate on this wire)', () => {
    rejects(
      row([
        ...examples.map(([key, value]) => known(key, value)),
        known('consumable', true),
      ]),
    );
  });

  const subsets = [
    ['dimensions', 'relevantDimensionCodes', 8],
    ['toyTypes', 'relevantDimensionCodes', 15],
    ['fit', 'relevantFitCodes', 3],
    ['capacity', 'relevantCapacityCodes', 2],
    ['equipment', 'relevantEquipmentCodes', 5],
    ['optional', 'optionalNonpertinenceCodes', 68],
  ] as const;
  describe.each(subsets)('%s local set', (name, key, maximum) => {
    function withCodes(codes: string[]) {
      const value =
        name === 'dimensions'
          ? { codes, toyTypes: [] }
          : name === 'toyTypes'
            ? { codes: [], toyTypes: codes }
            : codes;
      return row([known(key, value)]);
    }
    it('accepts empty and exact cap; rejects cap+1', () => {
      expect(assertFreshFactsCaptureV2(withCodes([]))).toBeUndefined();
      const codes = Array.from(
        { length: maximum },
        (_, index) => `code-${index}`,
      );
      expect(assertFreshFactsCaptureV2(withCodes(codes))).toBeUndefined();
      rejects(withCodes([...codes, 'extra']));
    });
    it('rejects exact duplicates without normalizing distinct strings or order', () => {
      rejects(withCodes(['same', 'same']));
      const input = withCodes([' X', 'x']);
      const before = structuredClone(input);
      expect(assertFreshFactsCaptureV2(input)).toBeUndefined();
      expect(input).toEqual(before);
    });
  });
  it('checks dimensions and toy types separately, allowing the same string in both', () => {
    const input = row([
      known('relevantDimensionCodes', {
        codes: ['shared'],
        toyTypes: ['shared'],
      }),
    ]);
    expect(assertFreshFactsCaptureV2(input)).toBeUndefined();
  });

  it.each([
    { sourceRef: '', verifiedOn: '2024-02-29' },
    { sourceRef: ' \u2003', verifiedOn: '2024-02-29' },
    { sourceRef: 'x'.repeat(1001), verifiedOn: '2024-02-29' },
    { sourceRef: 'page\u0000', verifiedOn: '2024-02-29' },
    { sourceRef: 'page\u007f', verifiedOn: '2024-02-29' },
    { sourceRef: '\ud800', verifiedOn: '2024-02-29' },
    { sourceRef: 'page', verifiedOn: '1900-02-29' },
    { sourceRef: 'page', verifiedOn: '2024-04-31' },
    { sourceRef: 'page', verifiedOn: '0000-01-01' },
    { sourceRef: 'page', verifiedOn: '2024-2-29' },
  ])('uses real evidence predicate for rejection: %j', (invalidEvidence) => {
    const declaration = known('consumable', false);
    if (declaration.state !== 'known') throw new Error('fixture');
    declaration.evidence = invalidEvidence;
    rejects(row([declaration]));
  });
  it.each(['2000-02-29', '9999-12-31'])(
    'accepts leap/future date %s with unchanged locator',
    (verifiedOn) => {
      const declaration = known('consumable', false);
      if (declaration.state !== 'known') throw new Error('fixture');
      declaration.evidence = { sourceRef: '  😀 page  ', verifiedOn };
      const input = row([declaration]);
      const before = structuredClone(input);
      expect(assertFreshFactsCaptureV2(input)).toBeUndefined();
      expect(input).toEqual(before);
    },
  );

  it.each([false, true])(
    'does not mutate deeply frozen passing/failing input: invalid=%s',
    (invalid) => {
      const input = row([
        known('relevantDimensionCodes', { codes: ['b', 'a'], toyTypes: [] }),
      ]);
      if (invalid) input.presentation = ' ';
      const before = structuredClone(input);
      freeze(input);
      if (invalid) rejects(input);
      else expect(assertFreshFactsCaptureV2(input)).toBeUndefined();
      expect(input).toEqual(before);
    },
  );
  it('leaves prepared care internals and foreign axis strings to separate gates', () => {
    const input = parseSellableFactsShapeV2({
      ...row([known('relevantFitCodes', ['foreign-axis'])]),
      careReview: {
        state: 'prepared',
        jurisdiction: '',
        intendedUse: '',
        determination: 'none_applicable',
        evidence: [{ sourceRef: '', verifiedOn: 'invalid' }],
        basis: '\ud800',
        requirements: [],
        warnings: [],
      },
    });
    const before = structuredClone(input);
    expect(assertFreshFactsCaptureV2(input)).toBeUndefined();
    expect(input).toEqual(before);
  });
});
