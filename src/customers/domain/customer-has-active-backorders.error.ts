import { EntityAlreadyExistsError } from '../../shared/domain/domain-error';

/**
 * `DELETE /customers/:id` while the customer has a WAITING or RESERVED
 * restock backorder (owner decision, restock-backorder L5). Answers 409.
 *
 * Extends `EntityAlreadyExistsError` so the shared `DomainExceptionFilter`
 * already answers 409 with its standard body (`statusCode`, `error`,
 * `message`, `timestamp`), exactly like the other domain 409s, without a
 * filter change; `error` and `message` carry the contract code and the Spanish
 * text the POS shows.
 */
export const CUSTOMER_HAS_ACTIVE_BACKORDERS = 'CUSTOMER_HAS_ACTIVE_BACKORDERS';

export class CustomerHasActiveBackordersError extends EntityAlreadyExistsError {
  constructor() {
    super('Customer', CUSTOMER_HAS_ACTIVE_BACKORDERS);
    // `code` is readonly on the base class; narrow it to this error's code.
    Object.assign(this, {
      code: CUSTOMER_HAS_ACTIVE_BACKORDERS,
      message: 'El cliente tiene pedidos por reposición activos',
    });
  }
}
