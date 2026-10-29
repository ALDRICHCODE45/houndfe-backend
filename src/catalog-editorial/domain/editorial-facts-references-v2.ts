import {
  FAMILY_CODES,
  isProductionFamily,
  NUMBERS,
} from './editorial-production-vocabulary-catalog';
import type { SellableFactsShapeV2 } from './editorial-sellable-facts-shape-v2';
import type { DefinitionV2 } from './editorial-vocabulary-definition-v2';
import type { FamilyV2 } from './editorial-vocabulary-family-shape-v2';

const contentMeasures = {
  mass: 'measure.net_mass',
  volume: 'measure.net_volume',
  count: 'measure.content_count',
  length: 'measure.coverage.length',
  area: 'measure.coverage.area',
} as const;
const permissions: Record<
  SellableFactsShapeV2['declarations'][number]['key'],
  readonly string[]
> = {
  contentMagnitude: FAMILY_CODES,
  optionalNonpertinenceCodes: FAMILY_CODES,
  consumable: ['hygiene'],
  animalApplied: ['hygiene'],
  relevantDimensionCodes: ['toy', 'hygiene', 'accessory', 'habitat', 'care'],
  fitDeterminesChoice: ['accessory'],
  relevantFitCodes: ['accessory'],
  capacityDeterminesChoice: ['accessory'],
  relevantCapacityCodes: ['accessory', 'habitat'],
  electricalApplies: ['accessory', 'habitat'],
  relevantEquipmentCodes: ['accessory', 'habitat'],
  presentationKind: ['care'],
};
function axes(prefix: string): ReadonlySet<string> {
  return new Set(
    NUMBERS.map(([code]) => code).filter((code) => code.startsWith(prefix)),
  );
}
const dimensionCodes = axes('measure.dimensions.');
const fitCodes = axes('measure.fit.');
const capacityCodes = axes('measure.capacity.');
const equipmentCodes = axes('measure.equipment.');
function invalid(): never {
  throw new Error('MALFORMED');
}

/** Parsed row and resolved, coherent, admitted metadata; no publication completeness. */
export function assertFreshFactsReferencesV2(
  row: SellableFactsShapeV2,
  family: FamilyV2,
  definitionsById: ReadonlyMap<string, DefinitionV2>,
): void {
  function bound(code: string) {
    const binding = family.bindings.find((b) => b.definitionCode === code);
    const definition = binding && definitionsById.get(binding.definitionId);
    if (!binding || !definition || definition.code !== code) invalid();
    return { binding, definition };
  }
  function subset(codes: string[], inventory: ReadonlySet<string>): void {
    for (const code of codes) {
      if (!inventory.has(code)) invalid();
      bound(code);
    }
  }
  if (row.careReview !== null && family.code !== 'care') invalid();
  const production = isProductionFamily(family.code);
  for (const declaration of row.declarations) {
    if (production) {
      if (!permissions[declaration.key].includes(family.code)) invalid();
    } else if (
      !['contentMagnitude', 'optionalNonpertinenceCodes'].includes(
        declaration.key,
      )
    ) {
      invalid();
    }
    if (declaration.state === 'unknown') continue;
    switch (declaration.key) {
      case 'contentMagnitude':
        bound(contentMeasures[declaration.value]);
        break;
      case 'relevantDimensionCodes': {
        subset(declaration.value.codes, dimensionCodes);
        if (family.code !== 'toy') {
          if (declaration.value.toyTypes.length) invalid();
        } else if (declaration.value.toyTypes.length) {
          const { definition } = bound('toy.type');
          if (definition.type !== 'multi') invalid();
          const options = new Set(definition.options.map((o) => o.code));
          if (declaration.value.toyTypes.some((code) => !options.has(code)))
            invalid();
        }
        break;
      }
      case 'relevantFitCodes':
        subset(declaration.value, fitCodes);
        break;
      case 'relevantCapacityCodes':
        subset(declaration.value, capacityCodes);
        if (
          family.code === 'accessory' &&
          declaration.value.some(
            (code) => code !== 'measure.capacity.container',
          )
        )
          invalid();
        break;
      case 'relevantEquipmentCodes':
        subset(declaration.value, equipmentCodes);
        break;
      case 'optionalNonpertinenceCodes':
        if (!production && declaration.value.length) invalid();
        for (const code of declaration.value) {
          const { binding } = bound(code);
          const policy = binding.policy;
          if (
            policy.route !== 'fact_rule' ||
            policy.rule.ruleId !== 'optional' ||
            policy.rule.family !== family.code ||
            policy.rule.parameter !== code
          )
            invalid();
        }
        break;
    }
  }
}
