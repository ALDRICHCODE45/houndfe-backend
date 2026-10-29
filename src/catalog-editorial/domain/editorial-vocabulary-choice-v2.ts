import {
  canonicalEditorialJson,
  CanonicalEditorialJsonError,
} from './editorial-canonical-json';
import { EditorialVocabularyRepresentationError } from './editorial-vocabulary-representation-error';
import { editorialAliasComparisonKeyV1 as comparisonKey } from './editorial-alias-comparison-v1';

export type OptionV2 = {
  code: string;
  label: string;
  archived: boolean;
  sortOrder: number;
};
export type GroupV2 = { code: string; label: string; optionCodes: string[] };
export type AliasV2 = { label: string; optionCode: string };
export type ChoiceDefinitionV2 = {
  id: string;
  code: string;
  label: string;
  type: 'single' | 'multi';
  options: OptionV2[];
  groups: GroupV2[];
  aliases: AliasV2[];
};

function invalid(): never {
  throw new EditorialVocabularyRepresentationError(
    'Expected a choice definition V2',
  );
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
function unique(code: string, seen: Set<string>): string {
  if (seen.has(code)) invalid();
  seen.add(code);
  return code;
}

/**
 * Closed shape and local-reference parser, NOT full admission.
 * Alias namespace collisions (S11/S12) and duplicate alias labels are NOT checked.
 * Use validateChoiceDefinitionV2 for definition-local namespace admission.
 * No runtime activation or assignment validation.
 */
export function parseChoiceDefinitionShapeV2(
  input: unknown,
): ChoiceDefinitionV2 {
  // Guard the entire tree before reading any submitted property.
  try {
    canonicalEditorialJson(input);
  } catch (error) {
    if (error instanceof CanonicalEditorialJsonError) invalid();
    throw error;
  }
  const d = closed(input, [
    'id',
    'code',
    'label',
    'type',
    'options',
    'groups',
    'aliases',
  ]);
  if (d.type !== 'single' && d.type !== 'multi') invalid();
  if (
    !Array.isArray(d.options) ||
    !Array.isArray(d.groups) ||
    !Array.isArray(d.aliases)
  ) {
    invalid();
  }
  const optionCodes = new Set<string>();
  const options = d.options.map((value: unknown): OptionV2 => {
    const o = closed(value, ['code', 'label', 'archived', 'sortOrder']);
    const code = unique(text(o.code), optionCodes);
    if (
      typeof o.archived !== 'boolean' ||
      typeof o.sortOrder !== 'number' ||
      !Number.isSafeInteger(o.sortOrder)
    ) {
      invalid();
    }
    return {
      code,
      label: text(o.label),
      archived: o.archived,
      sortOrder: o.sortOrder,
    };
  });
  const reference = (value: unknown): string => {
    const code = text(value);
    if (!optionCodes.has(code)) invalid();
    return code;
  };
  const groupCodes = new Set<string>();
  const groups = d.groups.map((value: unknown): GroupV2 => {
    const g = closed(value, ['code', 'label', 'optionCodes']);
    const code = unique(text(g.code), groupCodes);
    if (!Array.isArray(g.optionCodes)) invalid();
    const members = new Set<string>();
    return {
      code,
      label: text(g.label),
      optionCodes: g.optionCodes.map((member: unknown) =>
        unique(reference(member), members),
      ),
    };
  });
  const aliases = d.aliases.map((value: unknown): AliasV2 => {
    const a = closed(value, ['label', 'optionCode']);
    return { label: text(a.label), optionCode: reference(a.optionCode) };
  });
  return {
    id: text(d.id),
    code: text(d.code),
    label: text(d.label),
    type: d.type,
    options,
    groups,
    aliases,
  };
}

/** Dormant definition-local admission; no transport or assignment validation. */
export function validateChoiceDefinitionV2(input: unknown): ChoiceDefinitionV2 {
  const definition = parseChoiceDefinitionShapeV2(input);
  const labels = new Set<string>();
  const namespace = new Map<string, Set<string>>();
  const index = (label: string, optionCode: string): string => {
    // Deliberately outside the shape guard's catch: runtime errors must propagate.
    const key = comparisonKey(label);
    const targets = namespace.get(key) ?? new Set<string>();
    targets.add(optionCode);
    namespace.set(key, targets);
    return key;
  };
  for (const option of definition.options) {
    index(option.code, option.code);
    index(option.label, option.code);
  }
  const aliasKeys = definition.aliases.map((alias) => {
    unique(alias.label, labels);
    return index(alias.label, alias.optionCode);
  });
  // Check only after indexing every alias, so submission order cannot hide conflicts.
  definition.aliases.forEach((alias, i) => {
    const targets = namespace.get(aliasKeys[i])!;
    if (Array.from(targets).some((code) => code !== alias.optionCode))
      invalid();
  });
  return definition;
}
