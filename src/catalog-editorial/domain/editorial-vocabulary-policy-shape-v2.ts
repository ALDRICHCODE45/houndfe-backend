import { canonicalEditorialJson } from './editorial-canonical-json';
import {
  isProductionDefinitionCode,
  isProductionFamily,
  isProductionRuleId,
} from './editorial-production-vocabulary-catalog';
import type {
  ProductionDefinitionCode,
  ProductionFamily,
  RuleId,
} from './editorial-production-vocabulary-catalog';

export type OptionTest = {
  definitionCode: string;
  operator: 'equals_set' | 'contains_all' | 'intersects';
  optionCodes: string[];
};
export type PolicyCase = {
  code: string;
  when: OptionTest[];
  applicability: 'applicable' | 'not_applicable' | 'unresolved';
  required: boolean;
  allowNA: boolean;
  evidenceRequired: boolean;
  documentary: 'resolved' | 'not_applicable' | 'unresolved';
};
export type FactRule = {
  family: ProductionFamily;
  ruleId: RuleId;
  parameter: ProductionDefinitionCode;
};
export type BindingPolicy =
  | { route: 'pending' }
  | { route: 'option_cases'; cases: PolicyCase[] }
  | { route: 'fact_rule'; rule: FactRule };

function invalid(): never {
  throw new TypeError('Expected a binding policy shape V2');
}
function closed(value: unknown, keys: string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid();
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (
    actual.length !== keys.length ||
    keys.some((key) => !actual.includes(key))
  ) {
    invalid();
  }
  return record;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) invalid();
  return value;
}
function unique(value: string, seen: Set<string>): string {
  if (seen.has(value)) invalid();
  seen.add(value);
  return value;
}
function parseTest(input: unknown, seen: Set<string>): OptionTest {
  const t = closed(input, ['definitionCode', 'operator', 'optionCodes']);
  if (
    t.operator !== 'equals_set' &&
    t.operator !== 'contains_all' &&
    t.operator !== 'intersects'
  )
    invalid();
  if (!Array.isArray(t.optionCodes) || t.optionCodes.length === 0) invalid();
  const options = new Set<string>();
  return {
    definitionCode: unique(text(t.definitionCode), seen),
    operator: t.operator,
    optionCodes: t.optionCodes.map((value: unknown) =>
      unique(text(value), options),
    ),
  };
}
function parseCase(input: unknown, seen: Set<string>): PolicyCase {
  const c = closed(input, [
    'code',
    'when',
    'applicability',
    'required',
    'allowNA',
    'evidenceRequired',
    'documentary',
  ]);
  if (
    !Array.isArray(c.when) ||
    typeof c.required !== 'boolean' ||
    typeof c.allowNA !== 'boolean' ||
    typeof c.evidenceRequired !== 'boolean'
  )
    invalid();
  if (
    c.applicability !== 'applicable' &&
    c.applicability !== 'not_applicable' &&
    c.applicability !== 'unresolved'
  )
    invalid();
  if (
    c.documentary !== 'resolved' &&
    c.documentary !== 'not_applicable' &&
    c.documentary !== 'unresolved'
  )
    invalid();
  const tests = new Set<string>();
  return {
    code: unique(text(c.code), seen),
    when: c.when.map((value: unknown) => parseTest(value, tests)),
    applicability: c.applicability,
    required: c.required,
    allowNA: c.allowNA,
    evidenceRequired: c.evidenceRequired,
    documentary: c.documentary,
  };
}

/** Dormant closed shape only, NOT contextual or production triple admission. */
export function parseBindingPolicyShapeV2(input: unknown): BindingPolicy {
  // Guard the entire tree before reading any submitted property.
  try {
    canonicalEditorialJson(input);
  } catch {
    invalid();
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    invalid();
  const route = (input as Record<string, unknown>).route;
  if (route === 'pending') {
    closed(input, ['route']);
    return { route };
  }
  if (route === 'option_cases') {
    const p = closed(input, ['route', 'cases']);
    if (!Array.isArray(p.cases)) invalid();
    const seen = new Set<string>();
    return {
      route,
      cases: p.cases.map((value: unknown) => parseCase(value, seen)),
    };
  }
  if (route === 'fact_rule') {
    const p = closed(input, ['route', 'rule']);
    const r = closed(p.rule, ['family', 'ruleId', 'parameter']);
    if (
      !isProductionFamily(r.family) ||
      !isProductionRuleId(r.ruleId) ||
      !isProductionDefinitionCode(r.parameter)
    )
      invalid();
    return {
      route,
      rule: { family: r.family, ruleId: r.ruleId, parameter: r.parameter },
    };
  }
  return invalid();
}
