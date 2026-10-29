import { INVENTORY, OVERLAY } from './editorial-production-choice-inventory';
import { isProductionFamily } from './editorial-production-vocabulary-catalog';
import type { DefinitionV2 } from './editorial-vocabulary-definition-v2';
import type { FamilyV2 } from './editorial-vocabulary-family-shape-v2';
import { assertProductionNonnumericDefinitionTypesV2 } from './editorial-vocabulary-production-nonnumeric-types-v2';

// Private identity-only projection of the shared rows, not another authority.
const requiredByCode = new Map<string, Map<string, Set<string>>>();
for (const [code, group, , pairs] of INVENTORY) {
  const groups = requiredByCode.get(code) ?? new Map<string, Set<string>>();
  groups.set(
    group,
    new Set(
      pairs
        .split('; ')
        .map((pair) => `${group}.${pair.slice(0, pair.indexOf('='))}`),
    ),
  );
  requiredByCode.set(code, groups);
}
// Match the existing expansion: S7 appends to the FIRST hygiene.form group.
const hygieneGroups = requiredByCode.get('hygiene.form')!;
const firstHygieneGroup = Array.from(hygieneGroups.values())[0];
for (const [code] of OVERLAY) firstHygieneGroup.add(code);

/**
 * Trusted fresh production candidates only; not admission or legacy adoption.
 * Caller parses family, validates unique definitions indexed by actual IDs,
 * checks references and keeps inputs stable throughout this synchronous call.
 */
export function assertProductionChoiceCoverageV2(
  family: FamilyV2,
  definitionsById: ReadonlyMap<string, DefinitionV2>,
): void {
  assertProductionNonnumericDefinitionTypesV2(family, definitionsById);
  if (!isProductionFamily(family.code)) return;
  for (const binding of family.bindings) {
    const required = requiredByCode.get(binding.definitionCode);
    if (!required) continue;
    // Existence, code and exact choice type are guaranteed by the composition.
    const definition = definitionsById.get(binding.definitionId)!;
    if (definition.type !== 'single' && definition.type !== 'multi') continue;
    const options = new Set(definition.options.map((o) => o.code));
    const groups = new Map(
      definition.groups.map((g) => [g.code, new Set(g.optionCodes)]),
    );
    for (const [code, members] of required) {
      const actual = groups.get(code);
      if (
        !actual ||
        [...members].some(
          (member) => !options.has(member) || !actual.has(member),
        )
      )
        throw new TypeError('Expected production choice coverage V2');
    }
  }
}
