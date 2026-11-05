import { InvalidArgumentError } from '../../../shared/domain/domain-error';

// P4 S4 — a facet selection the catalog cannot filter by: an unknown,
// non-FACET or number/range definition, an unknown option, or any selection
// while the tenant switch is off. HTTP 400.
export class AttributeFacetNotAvailableError extends InvalidArgumentError {
  constructor(selection: string) {
    super(`Facet is not available: ${selection}`, 'FACET_NOT_AVAILABLE');
  }
}
