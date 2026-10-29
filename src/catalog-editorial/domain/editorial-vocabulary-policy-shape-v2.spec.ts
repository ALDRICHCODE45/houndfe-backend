import {
  parseBindingPolicyShapeV2 as parse,
  type BindingPolicy,
  type FactRule,
  type OptionTest,
  type PolicyCase,
} from './editorial-vocabulary-policy-shape-v2';

const test = (): OptionTest => ({
  definitionCode: ' legacy.selector ',
  operator: 'equals_set',
  optionCodes: ['z', ' A '],
});
const policyCase = (code = ' case '): PolicyCase => ({
  code,
  when: [test()],
  applicability: 'applicable',
  required: true,
  allowNA: false,
  evidenceRequired: true,
  documentary: 'resolved',
});
const fixture = () => ({
  route: 'option_cases' as const,
  cases: [policyCase('z'), { ...policyCase('a'), when: [] }],
});
const rule = (): FactRule => ({
  family: 'food',
  ruleId: 'required',
  parameter: 'animal.target',
});
const fact = () => ({ route: 'fact_rule', rule: rule() });
type Wire = Record<string, unknown>;
const caseAt = (d: Wire): Wire => (d.cases as Wire[])[0];
const testAt = (d: Wire): Wire => (caseAt(d).when as Wire[])[0];
const error = 'Expected a binding policy shape V2';

describe('dormant binding policy shape V2 (not full admission)', () => {
  it.each<BindingPolicy>([
    { route: 'pending' },
    fixture(),
    { route: 'option_cases', cases: [] },
    { route: 'fact_rule', rule: rule() },
  ])('accepts public branch example %#', (input) => {
    expect(parse(input)).toEqual(input);
  });

  it.each([
    ['pending', () => ({ route: 'pending' }), (d: Wire) => d],
    ['option root', fixture, (d: Wire) => d],
    ['case', fixture, caseAt],
    ['test', fixture, testAt],
    ['fact root', fact, (d: Wire) => d],
    ['rule', fact, (d: Wire) => d.rule as Wire],
  ] as const)(
    'requires every key and rejects extras at %s',
    (_, make, select) => {
      for (const key of Object.keys(select(make()))) {
        const input = make();
        delete select(input)[key];
        expect(() => parse(input)).toThrow(error);
      }
      const input = make();
      select(input).extra = true;
      expect(() => parse(input)).toThrow(error);
    },
  );

  it.each([
    { route: 'pending', cases: [] },
    { route: 'pending', rule: rule() },
    { ...fixture(), rule: rule() },
    { ...fact(), cases: [] },
    { ...fact(), status: 'resolved' },
    { route: 'unknown' },
    { route: 1 },
    null,
    [],
    'pending',
  ])('rejects branch contamination/invalid root %#', (input) => {
    expect(() => parse(input)).toThrow(error);
  });

  const levels = [
    ['root', (d: Wire) => d, 'cases', [null, {}, 'cases']],
    ['case', caseAt, 'code', ['', ' \t', 1]],
    ['case', caseAt, 'when', [null, {}, false]],
    ['case', caseAt, 'applicability', ['resolved', '', 1]],
    ['case', caseAt, 'documentary', ['applicable', '', false]],
    ['test', testAt, 'definitionCode', ['', '\n', 1]],
    ['test', testAt, 'operator', ['equals', '', 1]],
    ['test', testAt, 'optionCodes', [[], ['a', 'a'], [''], [' '], [1], null]],
  ] as const;
  it.each(levels)('rejects wrong %s.%s values', (_, select, key, values) => {
    for (const value of values) {
      const input = fixture();
      select(input)[key] = value;
      expect(() => parse(input)).toThrow(error);
    }
  });

  it.each(['required', 'allowNA', 'evidenceRequired'])(
    'requires a true boolean for %s',
    (key) => {
      for (const value of [0, 1, 'false', null]) {
        const input = fixture();
        caseAt(input)[key] = value;
        expect(() => parse(input)).toThrow(error);
      }
    },
  );

  it.each(['case', 'test', 'rule'])('rejects non-record %s', (level) => {
    const input: Wire = level === 'rule' ? fact() : fixture();
    if (level === 'rule') input.rule = [];
    else if (level === 'case') (input.cases as unknown[])[0] = null;
    else caseAt(input).when = ['test'];
    expect(() => parse(input)).toThrow(error);
  });

  it('rejects duplicate case/test identities, including differing test operators', () => {
    const input = fixture();
    input.cases.push(policyCase('z'));
    expect(() => parse(input)).toThrow(error);
    const other = fixture();
    other.cases[0].when.push({ ...test(), operator: 'intersects' });
    expect(() => parse(other)).toThrow(error);
  });

  it.each(['family', 'ruleId', 'parameter'] as const)(
    'checks exact global membership for rule.%s',
    (key) => {
      for (const value of [
        'unknown',
        ` ${rule()[key]}`,
        rule()[key].toUpperCase(),
        1,
        null,
      ]) {
        const input = fact();
        (input.rule as Wire)[key] = value;
        expect(() => parse(input)).toThrow(error);
      }
    },
  );

  it('accepts enums and independent memberships without contextual consistency', () => {
    for (const operator of [
      'equals_set',
      'contains_all',
      'intersects',
    ] as const) {
      for (const state of [
        'applicable',
        'not_applicable',
        'unresolved',
      ] as const) {
        const input = fixture();
        input.cases[0] = {
          ...policyCase(),
          applicability: state,
          documentary: state === 'applicable' ? 'resolved' : state,
          allowNA: true,
          when: [{ ...test(), operator }],
        };
        expect(parse(input)).toEqual(input);
      }
    }
    const input = {
      route: 'fact_rule',
      rule: { ...rule(), family: 'care', parameter: 'toy.type' },
    };
    expect(parse(input)).toEqual(input); // Global membership, not production triple admission.
  });

  it('preserves order/spelling, detaches all containers, and accepts frozen input', () => {
    const input = fixture();
    const freeze = (value: unknown): void => {
      if (value && typeof value === 'object') {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
      }
    };
    freeze(input);
    const output = parse(input);
    expect(output).toEqual(input);
    if (output.route !== 'option_cases') throw new Error('wrong branch');
    output.cases[0].when[0].optionCodes.push('new');
    output.cases[0].when.push(test());
    output.cases.push(policyCase());
    expect(input.cases).toHaveLength(2);
    expect(input.cases[0].when).toHaveLength(1);
    expect(input.cases[0].when[0].optionCodes).toEqual(['z', ' A ']);
    const source = fact();
    const parsed = parse(source);
    expect(parsed).not.toBe(source);
    if (parsed.route !== 'fact_rule') throw new Error('wrong branch');
    expect(parsed.rule).not.toBe(source.rule);
    expect(parse({ route: 'pending' })).toEqual({ route: 'pending' });
  });

  it('guards nested accessors without invoking them and rejects malformed trees', () => {
    const getter = jest.fn(() => 'equals_set');
    const input = fixture();
    Object.defineProperty(testAt(input), 'operator', {
      enumerable: true,
      get: getter,
    });
    expect(() => parse(input)).toThrow(error);
    expect(getter).not.toHaveBeenCalled();
    for (const value of [undefined, NaN, '\ud800']) {
      expect(() => parse({ ...fixture(), extra: value })).toThrow(error);
    }
    const cycle: Wire = { route: 'pending' };
    cycle.self = cycle;
    expect(() => parse(cycle)).toThrow(error);
  });
});
