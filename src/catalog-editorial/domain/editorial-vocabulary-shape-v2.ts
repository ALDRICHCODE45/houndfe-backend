import { canonicalEditorialJson } from './editorial-canonical-json';
import {
  validateDefinitionV2,
  type DefinitionV2,
} from './editorial-vocabulary-definition-v2';
import {
  parseFamilyShapeV2,
  type FamilyV2,
} from './editorial-vocabulary-family-shape-v2';

export type VocabularyV2 = {
  semanticsVersion: 'editorial-production-1';
  families: FamilyV2[];
  definitions: DefinitionV2[];
};

function invalid(): never {
  throw new TypeError('Expected a vocabulary shape V2');
}

function unique<T extends { id: string; code: string }>(values: T[]): T[] {
  const ids = new Set<string>();
  const codes = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id) || codes.has(value.code)) invalid();
    ids.add(value.id);
    codes.add(value.code);
  }
  return values;
}

/** Dormant closed root shape only; NOT full vocabulary admission. */
export function parseVocabularyShapeV2(input: unknown): VocabularyV2 {
  // Guard the entire tree before reading submitted properties or invoking leaves.
  try {
    canonicalEditorialJson(input);
  } catch {
    invalid();
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    invalid();
  const root = input as Record<string, unknown>;
  const keys = Object.keys(root);
  if (
    keys.length !== 3 ||
    !['semanticsVersion', 'families', 'definitions'].every((key) =>
      keys.includes(key),
    )
  )
    invalid();
  if (
    root.semanticsVersion !== 'editorial-production-1' ||
    !Array.isArray(root.families) ||
    !Array.isArray(root.definitions)
  )
    invalid();
  // Leaf failures (including unsupported Unicode runtime) must escape unchanged.
  return {
    semanticsVersion: root.semanticsVersion,
    families: unique(root.families.map(parseFamilyShapeV2)),
    definitions: unique(root.definitions.map(validateDefinitionV2)),
  };
}
