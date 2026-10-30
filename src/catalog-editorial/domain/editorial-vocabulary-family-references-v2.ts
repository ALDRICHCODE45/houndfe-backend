import { EditorialVocabularyRepresentationError } from './editorial-vocabulary-representation-error';
import type { DefinitionV2 } from './editorial-vocabulary-definition-v2';
import type { FamilyV2 } from './editorial-vocabulary-family-shape-v2';

function invalid(): never {
  throw new EditorialVocabularyRepresentationError(
    'Expected valid family references V2',
  );
}

type Node = {
  owner: 'product' | 'sellable';
  definition: DefinitionV2;
  dependencies: Set<string>;
  incoming: number;
};

/**
 * Trusted-input synchronous reference assertion, NOT an unknown-input parser or
 * full vocabulary/publication admission. Caller must first parseFamilyShapeV2,
 * validateDefinitionV2 for every definition, and establish unique IDs/codes.
 * The map must be keyed by actual definition IDs; inputs must remain unchanged
 * during this check. ReadonlyMap guarantees neither provenance nor deep immutability.
 * Returns void without mutating inputs; reference failures throw TypeError.
 */
export function assertFamilyReferencesV2(
  family: FamilyV2,
  definitionsById: ReadonlyMap<string, DefinitionV2>,
): void {
  const nodes = new Map<string, Node>();
  // Resolve every binding before traversing any policy, including pending/fact_rule.
  for (const binding of family.bindings) {
    const definition = definitionsById.get(binding.definitionId);
    if (!definition || definition.code !== binding.definitionCode) invalid();
    nodes.set(binding.definitionCode, {
      owner: binding.owner,
      definition,
      dependencies: new Set(),
      incoming: 0,
    });
  }

  const optionCodesBySelector = new Map<string, Set<string>>();
  for (const binding of family.bindings) {
    if (binding.policy.route !== 'option_cases') continue;
    const dependent = nodes.get(binding.definitionCode) ?? invalid();
    for (const policyCase of binding.policy.cases) {
      for (const test of policyCase.when) {
        const selector = nodes.get(test.definitionCode);
        if (!selector) invalid();
        if (binding.owner === 'product' && selector.owner === 'sellable')
          invalid();
        const definition = selector.definition;
        if (definition.type !== 'single' && definition.type !== 'multi') {
          invalid();
        }
        let optionCodes = optionCodesBySelector.get(test.definitionCode);
        if (!optionCodes) {
          optionCodes = new Set(
            definition.options.map((option) => option.code),
          );
          optionCodesBySelector.set(test.definitionCode, optionCodes);
        }
        if (test.optionCodes.some((code) => !optionCodes.has(code))) invalid();
        if (test.definitionCode === binding.definitionCode) invalid();
        // One edge per dependent/selector pair, unioned across ALL cases.
        if (!dependent.dependencies.has(test.definitionCode)) {
          dependent.dependencies.add(test.definitionCode);
          selector.incoming += 1;
        }
      }
    }
  }

  // Kahn's algorithm over all components: no recursive call stack or array shifts.
  // Edges point from dependent to tested binding, not in evaluation order.
  const ready = [...nodes.values()].filter((node) => node.incoming === 0);
  let visited = 0;
  for (let cursor = 0; cursor < ready.length; cursor += 1) {
    const node = ready[cursor];
    visited += 1;
    for (const code of node.dependencies) {
      const selector = nodes.get(code) ?? invalid();
      selector.incoming -= 1;
      if (selector.incoming === 0) ready.push(selector);
    }
  }
  if (visited !== nodes.size) invalid();
}
