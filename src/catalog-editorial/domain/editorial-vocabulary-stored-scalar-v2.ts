import {
  canonicalEditorialJson,
  CanonicalEditorialJsonError,
} from './editorial-canonical-json';
import { EditorialVocabularyRepresentationError } from './editorial-vocabulary-representation-error';
import {
  NumericDefinitionV2,
  validateNumericDefinitionV2,
} from './editorial-vocabulary-numeric-v2';
import {
  SimpleDefinitionV2,
  validateSimpleDefinitionV2,
} from './editorial-vocabulary-simple-v2';

function invalid(): never {
  throw new EditorialVocabularyRepresentationError(
    'Expected a representable stored scalar definition V2',
  );
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
export function materializeStoredScalarDefinitionV2(
  input: unknown,
): SimpleDefinitionV2 | NumericDefinitionV2 {
  // Guard all descriptors before reads, without closing future storage columns.
  try {
    canonicalEditorialJson(input);
  } catch (error) {
    if (error instanceof CanonicalEditorialJsonError) invalid();
    throw error;
  }
  const d = record(input);
  for (const key of ['options', 'groups', 'aliases']) {
    if (list(d[key]).length !== 0) invalid();
  }
  const rawUnits = list(d.units);
  const wire = { id: d.id, code: d.code, label: d.label, type: d.type };
  if (d.type === 'text' || d.type === 'boolean') {
    if (rawUnits.length !== 0 || d.numericPolicy !== null) invalid();
    return validateSimpleDefinitionV2(wire);
  }
  if (d.type !== 'number' && d.type !== 'range') invalid();
  const ids = new Set<string>();
  const units = rawUnits.map((value) => {
    const u = record(value);
    if (
      !Object.prototype.hasOwnProperty.call(u, 'id') ||
      typeof u.id !== 'string' ||
      ids.has(u.id) ||
      u.definitionId !== d.id ||
      u.definitionType !== d.type
    ) {
      invalid();
    }
    ids.add(u.id);
    return { code: u.unitCode, label: u.label, sortOrder: u.sortOrder };
  });
  // Do not close/prune policy here: the existing validator owns its semantics.
  // Keep delegation outside the guard catch so errors retain their identity.
  return validateNumericDefinitionV2({
    ...wire,
    units,
    numericPolicy: d.numericPolicy,
  });
}
