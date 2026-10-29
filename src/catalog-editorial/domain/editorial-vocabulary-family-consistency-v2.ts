import { EditorialVocabularyRepresentationError } from './editorial-vocabulary-representation-error';
import type { FamilyV2 } from './editorial-vocabulary-family-shape-v2';

/** Trusted parsed input only; dormant metadata assertion, not admission. */
export function assertFamilyPolicyConsistencyV2(family: FamilyV2): void {
  for (const binding of family.bindings) {
    if (binding.policy.route !== 'option_cases') continue;
    for (const policyCase of binding.policy.cases) {
      if (
        policyCase.required === true &&
        (policyCase.applicability !== 'applicable' ||
          binding.publicationCheck !== 'always')
      ) {
        throw new EditorialVocabularyRepresentationError(
          'Inconsistent family policy V2',
        );
      }
    }
  }
}
