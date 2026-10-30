import {
  evaluateFactRuleV2,
  type FactInputsV2,
} from './editorial-fact-rule-evaluation-v2';
import type { FactRule } from './editorial-vocabulary-policy-shape-v2';

type Outcome = 'O' | 'R' | 'N' | 'U';
const triples: [
  FactRule['ruleId'],
  FactRule['family'],
  FactRule['parameter'],
][] = [
  ['required', 'food', 'food.format'],
  ['optional', 'food', 'life.stage'],
  ['animal', 'hygiene', 'animal.target'],
  ['form', 'hygiene', 'hygiene.form'],
  ['content', 'food', 'measure.net_mass'],
  ['dimensions', 'toy', 'measure.dimensions.external_length'],
  ['fit', 'accessory', 'measure.fit.neck'],
  ['capacity', 'accessory', 'measure.capacity.container'],
  ['space', 'habitat', 'measure.capacity.container'],
  ['equipment', 'habitat', 'measure.equipment.power'],
  ['optional_equipment', 'accessory', 'measure.equipment.power'],
  ['presentation', 'care', 'care.form'],
];
function rule(id: FactRule['ruleId']): FactRule {
  const [, family, parameter] = triples.find(([key]) => key === id)!;
  return { family, parameter, ruleId: id };
}
function freeze(input: unknown): void {
  if (input !== null && typeof input === 'object') {
    Object.values(input).forEach(freeze);
    Object.freeze(input);
  }
}
function check(r: FactRule, facts: FactInputsV2, outcome: Outcome): void {
  const input = { r, facts };
  const before = structuredClone(input);
  freeze(input);
  const expected = {
    applicability:
      outcome === 'N'
        ? 'not_applicable'
        : outcome === 'U'
          ? 'unresolved'
          : 'applicable',
    required: outcome === 'R',
    allowNA: outcome === 'N',
    evidenceRequired: true,
    documentary: outcome === 'U' ? 'unresolved' : 'resolved',
  };
  try {
    const actual = evaluateFactRuleV2(r, facts);
    expect(actual).toEqual(expected);
    actual.required = !actual.required;
    expect(evaluateFactRuleV2(r, facts)).toEqual(expected);
  } finally {
    expect(input).toEqual(before);
  }
}

describe('production fact-rule result evaluation', () => {
  it.each(triples)(
    '%s handles omitted and unknown facts',
    (id, family, parameter) => {
      const unknown: FactInputsV2 = {
        contentMagnitude: null,
        consumable: null,
        animalApplied: null,
        fitDeterminesChoice: null,
        capacityDeterminesChoice: null,
        electricalApplies: null,
        relevantDimensionCodes: null,
        relevantFitCodes: null,
        relevantCapacityCodes: null,
        relevantEquipmentCodes: null,
        presentationKind: null,
        optionalNonpertinenceCodes: null,
      };
      const expected =
        id === 'required'
          ? 'R'
          : ['optional', 'optional_equipment'].includes(id)
            ? 'O'
            : 'U';
      for (const facts of [{}, unknown])
        check({ ruleId: id, family, parameter }, facts, expected);
    },
  );

  it('limits optional nonpertinence to the asserted parameter', () => {
    for (const codes of [[], ['life.stage'], ['pack.form']]) {
      check(
        rule('optional'),
        { optionalNonpertinenceCodes: codes },
        codes.includes('life.stage') ? 'N' : 'O',
      );
      check(rule('required'), { optionalNonpertinenceCodes: codes }, 'R');
    }
  });

  it.each(['animal', 'form'] as const)(
    '%s consumes explicit boolean findings',
    (id) => {
      for (const flag of [true, false]) {
        check(
          rule(id),
          { [id === 'animal' ? 'animalApplied' : 'consumable']: flag },
          flag ? 'R' : 'N',
        );
      }
    },
  );

  it.each([
    ['fit', 'fitDeterminesChoice', 'relevantFitCodes'],
    ['capacity', 'capacityDeterminesChoice', 'relevantCapacityCodes'],
    ['equipment', 'electricalApplies', 'relevantEquipmentCodes'],
    ['optional_equipment', 'electricalApplies', 'relevantEquipmentCodes'],
  ] as const)(
    '%s distinguishes flags, empty findings and subsets',
    (id, flagKey, subsetKey) => {
      const r = rule(id);
      // Synthetic unselected axes pin the table, not reference admission.
      const vectors: [boolean | null, string[] | null, Outcome, Outcome][] = [
        [true, null, 'U', 'U'],
        [true, [], 'U', 'U'],
        [true, [r.parameter], 'R', 'O'],
        [true, ['other-bound-axis'], 'O', 'O'],
        [false, null, 'N', 'N'],
        [false, [], 'N', 'N'],
        [false, [r.parameter], 'U', 'U'],
        [false, ['other-bound-axis'], 'U', 'U'],
        [null, null, 'U', 'O'],
        [null, [], 'U', 'O'],
        [null, [r.parameter], 'U', 'O'],
        [null, ['other-bound-axis'], 'U', 'O'],
      ];
      for (const [flag, axes, required, optional] of vectors) {
        check(
          r,
          { [flagKey]: flag, [subsetKey]: axes },
          id === 'optional_equipment' ? optional : required,
        );
      }
    },
  );

  it('selects toy dimension subsets without inferring absence of omitted axes', () => {
    const r = rule('dimensions');
    for (const codes of [
      [],
      [r.parameter],
      ['measure.dimensions.external_width'],
    ]) {
      check(
        r,
        { relevantDimensionCodes: { codes, toyTypes: ['toy'] } },
        !codes.length ? 'N' : codes.includes(r.parameter) ? 'R' : 'O',
      );
    }
  });

  it('requires both habitat subsets before choosing the parameter subset', () => {
    const capacity = rule('space');
    const dimension: FactRule = {
      ...capacity,
      parameter: 'measure.dimensions.external_length',
    };
    check(capacity, { relevantCapacityCodes: [capacity.parameter] }, 'U');
    check(
      dimension,
      {
        relevantDimensionCodes: { codes: [dimension.parameter], toyTypes: [] },
      },
      'U',
    );
    for (const r of [capacity, dimension]) {
      check(
        r,
        {
          relevantDimensionCodes: {
            codes: ['measure.dimensions.external_width'],
            toyTypes: [],
          },
          relevantCapacityCodes: ['measure.capacity.habitat_usable_volume'],
        },
        'O',
      );
      for (const selected of [true, false]) {
        check(
          r,
          {
            relevantDimensionCodes: {
              codes: [dimension.parameter],
              toyTypes: [],
            },
            relevantCapacityCodes: selected ? [capacity.parameter] : [],
          },
          r === dimension || selected ? 'R' : 'N',
        );
      }
      check(
        r,
        {
          relevantDimensionCodes: { codes: [], toyTypes: [] },
          relevantCapacityCodes: [],
        },
        'N',
      );
    }
  });

  it.each([
    ['mass', 'measure.net_mass'],
    ['volume', 'measure.net_volume'],
    ['count', 'measure.content_count'],
    ['length', 'measure.coverage.length'],
    ['area', 'measure.coverage.area'],
  ] as const)(
    'maps %s content to its exact measure',
    (magnitude, parameter) => {
      const r: FactRule = { ruleId: 'content', family: 'hygiene', parameter };
      check(r, { consumable: true, contentMagnitude: magnitude }, 'R');
      check(r, { consumable: false, contentMagnitude: magnitude }, 'N');
      check(r, { contentMagnitude: magnitude }, 'U');
      check(r, { consumable: true }, 'U');
      check(
        {
          ...r,
          parameter:
            parameter === 'measure.net_mass'
              ? 'measure.net_volume'
              : 'measure.net_mass',
        },
        { consumable: true, contentMagnitude: magnitude },
        'O',
      );
      check(
        { ...rule('content'), family: 'treat' },
        { contentMagnitude: magnitude },
        magnitude === 'length' || magnitude === 'area'
          ? 'U'
          : magnitude === 'mass'
            ? 'R'
            : 'O',
      );
    },
  );

  it.each(['toy', 'accessory', 'habitat'] as const)(
    '%s content remains optional',
    (family) => {
      for (const facts of [
        {},
        { contentMagnitude: 'mass' as const },
        { consumable: false },
      ]) {
        check({ ...rule('content'), family }, facts, 'O');
      }
    },
  );

  it.each(['food', 'treat', 'care'] as const)(
    '%s consumes known content without hygiene flag',
    (family) => {
      check(
        { ...rule('content'), family },
        { contentMagnitude: 'mass', consumable: false },
        'R',
      );
      check(
        { ...rule('content'), family },
        { contentMagnitude: 'volume' },
        'O',
      );
    },
  );

  it.each([
    ['formulation', 'care.form'],
    ['device', 'care.device'],
    ['packaging', 'pack.form'],
  ] as const)(
    'selects %s presentation, not every representation',
    (kind, selected) => {
      for (const parameter of [
        'care.form',
        'care.device',
        'pack.form',
      ] as const) {
        check(
          { ...rule('presentation'), parameter },
          { presentationKind: kind },
          parameter === selected ? 'R' : 'O',
        );
      }
    },
  );
});
