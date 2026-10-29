import {
  canonicalEditorialJson,
  CanonicalEditorialJsonError,
} from './editorial-canonical-json';
import { EditorialVocabularyRepresentationError } from './editorial-vocabulary-representation-error';
import {
  type FamilyV2,
  parseFamilyShapeV2,
} from './editorial-vocabulary-family-shape-v2';

function invalid(): never {
  throw new EditorialVocabularyRepresentationError(
    'Expected a representable stored family V2',
  );
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid();
  }
  return value as Record<string, unknown>;
}

/** Dormant raw-row boundary, not reference or minimum-version admission. */
export function materializeStoredFamilyV2(input: unknown): FamilyV2 {
  // Guard all descriptors before reads; future storage columns remain open.
  try {
    canonicalEditorialJson(input);
  } catch (error) {
    if (error instanceof CanonicalEditorialJsonError) invalid();
    throw error;
  }
  const f = record(input);
  if (!Array.isArray(f.bindings)) invalid();
  const bindings = f.bindings.map((value: unknown) => {
    const b = record(value);
    if (
      !Object.prototype.hasOwnProperty.call(b, 'familyId') ||
      b.familyId !== f.id
    ) {
      invalid();
    }
    return {
      definitionId: b.definitionId,
      definitionCode: b.definitionCode,
      owner: b.owner,
      sortOrder: b.sortOrder,
      exposure: b.exposure,
      searchable: b.searchable,
      publicationCheck: b.publicationCheck,
      policy: b.policy,
    };
  });
  // Delegate whole semantic policies outside the guard catch, preserving errors.
  return parseFamilyShapeV2({
    id: f.id,
    code: f.code,
    label: f.label,
    minimumContractVersion: f.minimumContractVersion,
    bindings,
  });
}
