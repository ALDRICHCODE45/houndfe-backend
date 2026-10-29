import {
  CHOICES,
  FAMILY_CODES,
  NUMBERS,
  OTHER,
  type RuleId,
} from './editorial-production-vocabulary-catalog';
import type {
  BindingV2,
  FamilyV2,
} from './editorial-vocabulary-family-shape-v2';

type Expected = Readonly<{
  ruleId: string;
  exposure: BindingV2['exposure'];
  publicationCheck: BindingV2['publicationCheck'];
}>;
const exposures = { F: 'FACET', D: 'DETAIL', I: 'INTERNAL' } as const;
const always: readonly RuleId[] = [
  'required',
  'animal',
  'form',
  'fit',
  'capacity',
  'space',
  'presentation',
  'dimensions',
  'equipment',
];

// Private derived lookup; never exposed or modified after construction.
const expectedByFamily: ReadonlyMap<
  string,
  ReadonlyMap<string, Expected>
> = (() => {
  const families = new Map<string, Map<string, Expected>>(
    FAMILY_CODES.map((code) => [code, new Map()]),
  );
  function add(
    code: string,
    exposure: keyof typeof exposures,
    spec: string,
  ): void {
    for (const token of spec.split(',')) {
      const [familyToken, ruleId] = token.split(':');
      for (const family of familyToken === 'ALL'
        ? FAMILY_CODES
        : [familyToken]) {
        const publicationCheck =
          always.includes(ruleId as RuleId) ||
          (ruleId === 'content' &&
            ['food', 'treat', 'hygiene', 'care'].includes(family))
            ? 'always'
            : 'when_asserted';
        families.get(family)!.set(
          code,
          Object.freeze({
            ruleId,
            exposure: exposures[exposure],
            publicationCheck,
          }),
        );
      }
    }
  }
  for (const [code, , exposure, spec] of CHOICES) add(code, exposure, spec);
  for (const [code, , , exposure, , spec] of NUMBERS) add(code, exposure, spec);
  for (const [code, , familySpec, exposure] of OTHER) {
    const spec =
      familySpec === 'ALL'
        ? 'ALL:optional'
        : familySpec
            .split(',')
            .map((family) => `${family}:optional`)
            .join(',');
    add(code, exposure, spec);
  }
  return families;
})();

function invalid(): never {
  throw new TypeError('Expected production binding policies V2');
}

/**
 * Fresh candidates only, NOT legacy reads/replay/provisioning or adoption authorization.
 * Caller parses family, validates/indexes unique definitions and checks references;
 * inputs must remain stable during this synchronous, non-mutating assertion.
 * Success returns void, not an admitted DTO or publication authorization.
 */
export function assertProductionBindingPoliciesV2(family: FamilyV2): void {
  const expected = expectedByFamily.get(family.code);
  if (!expected) {
    if (family.bindings.some((b) => b.policy.route === 'fact_rule')) invalid();
    return;
  }
  if (family.bindings.length !== expected.size) invalid();
  // Local code uniqueness is a parsed-family precondition: size + membership is set equality.
  for (const b of family.bindings) {
    const target = expected.get(b.definitionCode);
    if (
      !target ||
      b.owner !== 'sellable' ||
      b.searchable !== false ||
      b.exposure !== target.exposure ||
      b.publicationCheck !== target.publicationCheck ||
      b.policy.route !== 'fact_rule'
    )
      invalid();
    const rule = b.policy.rule;
    if (
      rule.family !== family.code ||
      rule.parameter !== b.definitionCode ||
      rule.ruleId !== target.ruleId
    )
      invalid();
  }
}
