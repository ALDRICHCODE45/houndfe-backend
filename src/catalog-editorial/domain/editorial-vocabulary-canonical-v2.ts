import { Buffer } from 'node:buffer';
import { hashEditorialJson } from './editorial-canonical-json';
import { validateVocabularyConsistencyV2 } from './editorial-vocabulary-consistency-v2';
import type { VocabularyV2 } from './editorial-vocabulary-shape-v2';

function text(a: string | null, b: string | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
function integer(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function orderedCode(
  a: { sortOrder: number; code: string | null },
  b: { sortOrder: number; code: string | null },
): number {
  return integer(a.sortOrder, b.sortOrder) || text(a.code, b.code);
}

/** Generic representation only: validation detaches the tree before sorting. */
export function canonicalizeVocabularyV2(input: unknown): VocabularyV2 {
  const vocabulary = validateVocabularyConsistencyV2(input);
  vocabulary.families.sort(
    (a, b) => text(a.label, b.label) || text(a.code, b.code),
  );
  vocabulary.definitions.sort((a, b) => text(a.code, b.code));
  for (const family of vocabulary.families) {
    family.bindings.sort(
      (a, b) =>
        integer(a.sortOrder, b.sortOrder) ||
        text(a.definitionCode, b.definitionCode),
    );
    for (const { policy } of family.bindings) {
      if (policy.route !== 'option_cases') continue;
      policy.cases.sort((a, b) => text(a.code, b.code));
      for (const rule of policy.cases) {
        rule.when.sort((a, b) => text(a.definitionCode, b.definitionCode));
        for (const test of rule.when) test.optionCodes.sort(text);
      }
    }
  }
  for (const definition of vocabulary.definitions) {
    if (definition.type === 'single' || definition.type === 'multi') {
      definition.options.sort(orderedCode);
      definition.groups.sort((a, b) => text(a.code, b.code));
      definition.aliases.sort(
        (a, b) => text(a.label, b.label) || text(a.optionCode, b.optionCode),
      );
      for (const group of definition.groups) group.optionCodes.sort(text);
    } else if (definition.type === 'number' || definition.type === 'range') {
      definition.units.sort(orderedCode);
    }
  }
  return vocabulary;
}

/** Content identity, not admission, publication permission or tenant identity. */
export function createVocabularyResponseV2(input: unknown): {
  contractVersion: 2;
  vocabularyRevision: string;
  vocabulary: VocabularyV2;
} {
  const vocabulary = canonicalizeVocabularyV2(input);
  const digest = hashEditorialJson({ contractVersion: 2, vocabulary });
  return {
    contractVersion: 2,
    vocabularyRevision: `ev2-sha256-${digest}`,
    vocabulary,
  };
}
