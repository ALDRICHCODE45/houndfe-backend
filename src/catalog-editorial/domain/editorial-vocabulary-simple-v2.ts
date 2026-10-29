import {
  canonicalEditorialJson,
  CanonicalEditorialJsonError,
} from './editorial-canonical-json';
import { EditorialVocabularyRepresentationError } from './editorial-vocabulary-representation-error';

export type SimpleDefinitionV2 = {
  id: string;
  code: string;
  label: string;
  type: 'text' | 'boolean';
};

function invalid(): never {
  throw new EditorialVocabularyRepresentationError(
    'Expected a simple definition V2',
  );
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) invalid();
  return value;
}

/** Closed metadata leaf only; no assignment validation or runtime activation. */
export function validateSimpleDefinitionV2(input: unknown): SimpleDefinitionV2 {
  // Guard descriptors and the entire tree before reading any submitted property.
  try {
    canonicalEditorialJson(input);
  } catch (error) {
    if (error instanceof CanonicalEditorialJsonError) invalid();
    throw error;
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    invalid();
  }
  const d = input as Record<string, unknown>;
  const keys = Object.keys(d);
  if (
    keys.length !== 4 ||
    ['id', 'code', 'label', 'type'].some((key) => !keys.includes(key))
  ) {
    invalid();
  }
  if (d.type !== 'text' && d.type !== 'boolean') invalid();
  return {
    id: text(d.id),
    code: text(d.code),
    label: text(d.label),
    type: d.type,
  };
}
