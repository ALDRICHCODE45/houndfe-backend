import type { DeclarationShapeV2 } from './editorial-declaration-shape-v2';
import type { RuleResultV2 } from './editorial-option-case-evaluation-v2';
import type { FactRule } from './editorial-vocabulary-policy-shape-v2';

type Known = Extract<DeclarationShapeV2, { state: 'known' }>;
export type FactInputsV2 = {
  [K in Known['key']]?: Extract<Known, { key: K }>['value'] | null;
};
type Outcome = 'O' | 'R' | 'N' | 'U';
const contentMeasures = {
  mass: 'measure.net_mass',
  volume: 'measure.net_volume',
  count: 'measure.content_count',
  length: 'measure.coverage.length',
  area: 'measure.coverage.area',
};
const presentations = {
  formulation: 'care.form',
  device: 'care.device',
  packaging: 'pack.form',
};
// D8 (b): for these accessory types an unknown capacity declaration defaults
// to «No»; a known declaration always wins. Accessory electrical fields use
// optional_equipment, which an unknown declaration already leaves optional.
const declaredNoAccessoryTypes: ReadonlySet<string> = new Set([
  'accessory.type.collar',
  'accessory.type.harness',
  'accessory.type.leash',
]);

function subset(
  code: string,
  axes: readonly string[] | null | undefined,
  required = true,
): Outcome {
  if (axes == null) return 'U';
  if (axes.length === 0) return 'N';
  return required && axes.includes(code) ? 'R' : 'O';
}
function flag(
  code: string,
  applies: boolean | null | undefined,
  axes: readonly string[] | null | undefined,
  required = true,
): Outcome {
  if (applies === false) return axes?.length ? 'U' : 'N';
  if (applies === true)
    return axes?.length ? subset(code, axes, required) : 'U';
  return required ? 'U' : 'O';
}
function resolve(
  rule: FactRule,
  facts: Readonly<FactInputsV2>,
  accessoryTypes: readonly string[],
): Outcome {
  const { family, parameter, ruleId } = rule;
  const defaultsToNo =
    family === 'accessory' &&
    accessoryTypes.length > 0 &&
    accessoryTypes.every((code) => declaredNoAccessoryTypes.has(code));
  const declared = (value: boolean | null | undefined) =>
    value ?? (defaultsToNo ? false : value);
  switch (ruleId) {
    case 'required':
      return 'R';
    case 'optional':
      return facts.optionalNonpertinenceCodes?.includes(parameter) ? 'N' : 'O';
    case 'animal':
    case 'form': {
      const applies =
        ruleId === 'animal' ? facts.animalApplied : facts.consumable;
      return applies === false ? 'N' : applies === true ? 'R' : 'U';
    }
    case 'content': {
      if (!['food', 'treat', 'hygiene', 'care'].includes(family)) return 'O';
      if (family === 'hygiene') {
        if (facts.consumable === false) return 'N';
        if (facts.consumable !== true) return 'U';
      }
      const magnitude = facts.contentMagnitude;
      if (
        magnitude == null ||
        (family === 'treat' && (magnitude === 'length' || magnitude === 'area'))
      )
        return 'U';
      return parameter === contentMeasures[magnitude] ? 'R' : 'O';
    }
    case 'dimensions':
      return subset(parameter, facts.relevantDimensionCodes?.codes);
    case 'space':
      if (
        facts.relevantDimensionCodes == null ||
        facts.relevantCapacityCodes == null
      )
        return 'U';
      return subset(
        parameter,
        parameter.startsWith('measure.dimensions.')
          ? facts.relevantDimensionCodes.codes
          : facts.relevantCapacityCodes,
      );
    case 'fit':
      return flag(parameter, facts.fitDeterminesChoice, facts.relevantFitCodes);
    case 'capacity':
      return flag(
        parameter,
        declared(facts.capacityDeterminesChoice),
        facts.relevantCapacityCodes,
      );
    case 'equipment':
    case 'optional_equipment':
      return flag(
        parameter,
        facts.electricalApplies,
        facts.relevantEquipmentCodes,
        ruleId !== 'optional_equipment',
      );
    case 'presentation':
      return facts.presentationKind == null
        ? 'U'
        : parameter === presentations[facts.presentationKind]
          ? 'R'
          : 'O';
  }
}

/**
 * Qualified known facts only; no raw capture validation or publication admission.
 * `accessoryTypes` are the subject's selected `accessory.type` option codes.
 */
export function evaluateFactRuleV2(
  rule: FactRule,
  facts: Readonly<FactInputsV2>,
  accessoryTypes: readonly string[] = [],
): RuleResultV2 {
  const outcome = resolve(rule, facts, accessoryTypes);
  return {
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
}
