import { EntityAlreadyExistsError } from '../../shared/domain/domain-error';

/**
 * Deleting a variant (`DELETE /products/:id/variants/:variantId`) that has any
 * restock backorder, in ANY status: backorders keep their variant as history
 * (`backorders.variantId` is `ON DELETE RESTRICT`), so the database used to
 * refuse with a generic relation error (restock-backorder T8 b). Answers 409
 * before anything is written (the variant, its stock and the journal stay).
 *
 * Same technique as `ProductHasActiveBackordersError`: extends
 * `EntityAlreadyExistsError` so the shared `DomainExceptionFilter` answers 409
 * with its standard body (`statusCode`, `error`, `message`, `timestamp`);
 * `error` carries the code and `message` the Spanish text the POS shows.
 */
export const VARIANT_HAS_BACKORDERS = 'VARIANT_HAS_BACKORDERS';

export class VariantHasBackordersError extends EntityAlreadyExistsError {
  constructor() {
    super('Variant', VARIANT_HAS_BACKORDERS);
    // `code` is readonly on the base class; narrow it to this error's code.
    Object.assign(this, {
      code: VARIANT_HAS_BACKORDERS,
      message: 'La variante tiene pedidos por reposición',
    });
  }
}
