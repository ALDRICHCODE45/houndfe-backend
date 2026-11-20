import { EntityAlreadyExistsError } from '../../shared/domain/domain-error';

/**
 * Adding the first variant (`POST /products/:id/variants`) or enabling variants
 * (`PATCH /products/:id {hasVariants:true}`) while the product has a WAITING or
 * RESERVED product-level backorder (`variantId` null) — converting it would
 * strand the backorder, whose units live on the product row (restock-backorder
 * L8 / L13). Answers 409.
 *
 * Extends `EntityAlreadyExistsError` so the shared `DomainExceptionFilter`
 * already answers 409 with its standard body (`statusCode`, `error`,
 * `message`, `timestamp`) without a filter change — the same technique as
 * `CustomerHasActiveBackordersError`; `error` carries the code and `message`
 * the Spanish text the POS shows.
 */
export const PRODUCT_HAS_ACTIVE_BACKORDERS = 'PRODUCT_HAS_ACTIVE_BACKORDERS';

export class ProductHasActiveBackordersError extends EntityAlreadyExistsError {
  constructor() {
    super('Product', PRODUCT_HAS_ACTIVE_BACKORDERS);
    // `code` is readonly on the base class; narrow it to this error's code.
    Object.assign(this, {
      code: PRODUCT_HAS_ACTIVE_BACKORDERS,
      message: 'El producto tiene pedidos por reposición activos',
    });
  }
}
