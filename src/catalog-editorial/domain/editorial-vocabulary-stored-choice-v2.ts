import { canonicalEditorialJson } from './editorial-canonical-json';
import {
  ChoiceDefinitionV2,
  validateChoiceDefinitionV2,
} from './editorial-vocabulary-choice-v2';

function invalid(): never {
  throw new TypeError('Expected a representable stored choice definition V2');
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

/** Dormant raw-row boundary; no snapshot, family or transport admission. */
export function materializeStoredChoiceDefinitionV2(
  input: unknown,
): ChoiceDefinitionV2 {
  // Check descriptors throughout the raw JSON tree before reading properties.
  // This guard permits future storage columns; it does not close row keys.
  try {
    canonicalEditorialJson(input);
  } catch {
    invalid();
  }
  const d = record(input);
  if (d.type !== 'single' && d.type !== 'multi') invalid();
  if (d.numericPolicy !== null || list(d.units).length !== 0) invalid();
  const child = (value: unknown, typed: boolean) => {
    const row = record(value);
    if (row.definitionId !== d.id || (typed && row.definitionType !== d.type)) {
      invalid();
    }
    return row;
  };
  const options = list(d.options).map((value) => {
    const o = child(value, true);
    if (o.archivedAt !== null && typeof o.archivedAt !== 'string') {
      invalid();
    }
    return {
      code: o.code,
      label: o.label,
      sortOrder: o.sortOrder,
      archived: o.archivedAt !== null,
    };
  });
  const groups = list(d.groups).map((value) => {
    const g = child(value, true);
    return {
      code: g.code,
      label: g.label,
      optionCodes: list(g.members).map((value) => {
        const member = child(value, false);
        if (member.groupCode !== g.code) invalid();
        return member.optionCode;
      }),
    };
  });
  const aliases = list(d.aliases).map((value) => {
    const a = child(value, false);
    return { label: a.label, optionCode: a.optionCode };
  });
  // Copy only wire fields, never storage parents/timestamps/future columns.
  // The existing validator owns required DTO fields, references and collisions.
  return validateChoiceDefinitionV2({
    id: d.id,
    code: d.code,
    label: d.label,
    type: d.type,
    options,
    groups,
    aliases,
  });
}
