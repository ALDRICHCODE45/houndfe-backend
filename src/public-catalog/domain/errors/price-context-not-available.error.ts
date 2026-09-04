import { DomainError } from '../../../shared/domain/domain-error';

// F2.WU6 — one generic miss for private/nonexistent/cross-tenant/unbound/
// absent-default inputs; identical error, HTTP 404, never a second lookup.
export class PriceContextNotAvailableError extends DomainError {
  constructor() {
    super('Price context is not available', 'PRICE_CONTEXT_NOT_AVAILABLE');
  }
}
