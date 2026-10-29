import { canonicalEditorialJson } from './editorial-canonical-json';
import { validateVocabularyConsistencyV2 } from './editorial-vocabulary-consistency-v2';
import type { VocabularyV2 } from './editorial-vocabulary-shape-v2';
import { materializeStoredChoiceDefinitionV2 } from './editorial-vocabulary-stored-choice-v2';
import { materializeStoredFamilyV2 } from './editorial-vocabulary-stored-family-v2';
import { materializeStoredScalarDefinitionV2 } from './editorial-vocabulary-stored-scalar-v2';

function invalid(): never {
  throw new TypeError('Expected a representable stored vocabulary V2');
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid();
  }
  return value as Record<string, unknown>;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) invalid();
  return value;
}

/** Dormant structural intermediate, not snapshot provenance or S29 admission. */
export function materializeStoredVocabularyV2(input: unknown): VocabularyV2 {
  // Guard the entire tree, including discarded storage fields, before reads.
  try {
    canonicalEditorialJson(input);
  } catch {
    invalid();
  }
  const root = record(input);
  const metadata = record(root.metadata);
  if (
    metadata.id !== 'global' ||
    metadata.semanticsVersion !== 'editorial-production-1'
  ) {
    invalid();
  }
  const families = list(root.families);
  const definitions = list(root.definitions).map(record);
  // Units alone have global storage child IDs. Check before leaves drop them;
  // choice child identities are composite/local and must not be globalized.
  const unitIds = new Set<string>();
  for (const definition of definitions) {
    for (const value of list(definition.units)) {
      const unit = record(value);
      if (typeof unit.id !== 'string' || unitIds.has(unit.id)) invalid();
      unitIds.add(unit.id);
    }
  }
  // All delegation stays outside the JSON-guard catch, preserving errors.
  return validateVocabularyConsistencyV2({
    semanticsVersion: metadata.semanticsVersion,
    families: families.map(materializeStoredFamilyV2),
    definitions: definitions.map((definition) =>
      definition.type === 'single' || definition.type === 'multi'
        ? materializeStoredChoiceDefinitionV2(definition)
        : materializeStoredScalarDefinitionV2(definition),
    ),
  });
}
