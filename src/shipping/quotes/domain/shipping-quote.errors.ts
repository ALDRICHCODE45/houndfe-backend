/**
 * shipping-zones / T3 — quote failures with stable codes. Messages never carry
 * phones or addresses: the bot audit log stores error messages verbatim.
 * HTTP statuses are mapped by the bot controller (docs/shipping-quotes.md §5).
 */
import { DomainError } from '../../../shared/domain/domain-error';

export type ShippingQuoteErrorCode =
  | 'INVALID_SHIPPING_DESTINATION'
  | 'PRODUCT_NOT_FOUND'
  | 'VARIANT_NOT_FOUND'
  | 'SHIPPING_ADDRESS_NOT_FOUND'
  | 'SHIPPING_ADDRESS_INCOMPLETE'
  | 'CUSTOMER_PHONE_AMBIGUOUS'
  | 'SHIPPING_ORIGIN_NOT_CONFIGURED';

export class ShippingQuoteError extends DomainError {
  constructor(
    code: ShippingQuoteErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message, code);
  }
}
