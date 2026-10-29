import {
  canonicalEditorialJson,
  CanonicalEditorialJsonError,
} from './editorial-canonical-json';
import { EditorialVocabularyRepresentationError } from './editorial-vocabulary-representation-error';
import {
  ChoiceDefinitionV2,
  validateChoiceDefinitionV2,
} from './editorial-vocabulary-choice-v2';
import {
  NumericDefinitionV2,
  validateNumericDefinitionV2,
} from './editorial-vocabulary-numeric-v2';
import {
  SimpleDefinitionV2,
  validateSimpleDefinitionV2,
} from './editorial-vocabulary-simple-v2';

export type DefinitionV2 =
  | SimpleDefinitionV2
  | NumericDefinitionV2
  | ChoiceDefinitionV2;

function invalid(): never {
  throw new EditorialVocabularyRepresentationError('Expected a definition V2');
}

/** Dormant metadata admission only; no whole-vocabulary or assignment validation. */
export function validateDefinitionV2(input: unknown): DefinitionV2 {
  // Guard the entire tree before reading the submitted discriminant.
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
  if (!Object.prototype.hasOwnProperty.call(d, 'type')) invalid();
  // Keep leaf validation outside the catch, including Unicode runtime errors.
  switch (d.type) {
    case 'text':
    case 'boolean':
      return validateSimpleDefinitionV2(input);
    case 'number':
    case 'range':
      return validateNumericDefinitionV2(input);
    case 'single':
    case 'multi':
      return validateChoiceDefinitionV2(input);
    default:
      return invalid();
  }
}
