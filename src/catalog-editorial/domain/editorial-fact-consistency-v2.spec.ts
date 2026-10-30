import { assertFactConsistencyV2 as assertConsistent } from './editorial-fact-consistency-v2';
import type { FactInputsV2 } from './editorial-fact-rule-evaluation-v2';

const pairs = [
  ['fitDeterminesChoice', 'relevantFitCodes', 'measure.fit.neck'],
  [
    'capacityDeterminesChoice',
    'relevantCapacityCodes',
    'measure.capacity.container',
  ],
  ['electricalApplies', 'relevantEquipmentCodes', 'measure.equipment.power'],
] as const;
function freeze(facts: FactInputsV2): Readonly<FactInputsV2> {
  for (const value of Object.values(facts)) {
    if (value && typeof value === 'object') Object.freeze(value);
  }
  return Object.freeze(facts);
}
function rejects(facts: Readonly<FactInputsV2>): void {
  let caught: unknown;
  try {
    assertConsistent(facts);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(Object.getPrototypeOf(caught)).toBe(Error.prototype);
  expect((caught as Error).message).toBe('MALFORMED');
}

describe.each(pairs)('%s and %s', (flag, subset, code) => {
  describe.each([undefined, null, false, true])('flag=%s', (applies) => {
    it.each([
      { codes: undefined },
      { codes: null },
      { codes: [] },
      { codes: [code] },
    ])('compares known subset $codes', ({ codes }) => {
      const facts = freeze({ [flag]: applies, [subset]: codes });
      const before = structuredClone(facts);
      if (applies === false && codes != null && codes.length > 0) {
        rejects(facts);
      } else {
        expect(assertConsistent(facts)).toBeUndefined();
      }
      expect(facts).toEqual(before);
    });
  });

  it('rejects independently without an attribute assignment or policy seed', () => {
    const facts = freeze({ [flag]: false, [subset]: [code] });
    rejects(facts);
    expect(facts[flag]).toBe(false);
    expect(facts[subset]).toEqual([code]);
  });

  it('does not treat an absent flag or subset as a known contradiction', () => {
    expect(assertConsistent(freeze({ [subset]: [code] }))).toBeUndefined();
    expect(assertConsistent(freeze({ [flag]: false }))).toBeUndefined();
  });
});

it.each(pairs)(
  'does not let an earlier valid pair hide %s',
  (flag, subset, code) => {
    const facts = freeze({
      fitDeterminesChoice: true,
      relevantFitCodes: ['measure.fit.neck'],
      capacityDeterminesChoice: false,
      relevantCapacityCodes: [],
      electricalApplies: true,
      relevantEquipmentCodes: ['measure.equipment.power'],
      [flag]: false,
      [subset]: [code],
    });
    const before = structuredClone(facts);
    rejects(facts);
    expect(facts).toEqual(before);
  },
);

it('does not cross-match independent flags and subsets', () => {
  const facts = freeze({
    fitDeterminesChoice: false,
    relevantFitCodes: [],
    capacityDeterminesChoice: true,
    relevantCapacityCodes: ['measure.capacity.container'],
    electricalApplies: false,
    relevantEquipmentCodes: [],
  });
  expect(assertConsistent(facts)).toBeUndefined();
});

it('leaves unknown minima, true-plus-empty and habitat exceptions to other gates', () => {
  expect(assertConsistent(freeze({}))).toBeUndefined();
  const facts = freeze({
    fitDeterminesChoice: true,
    relevantFitCodes: [],
    capacityDeterminesChoice: true,
    relevantCapacityCodes: [],
    electricalApplies: true,
    relevantEquipmentCodes: [],
  });
  expect(assertConsistent(facts)).toBeUndefined();
});
