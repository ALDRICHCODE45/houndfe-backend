/**
 * Every error code the bot backorder routes can answer, with its HTTP status
 * (contract v1 §6.1, §6.2, §6.4). Bodies are code-only: `{ statusCode, error,
 * message }` with `error === message`, plus the small detail member named in
 * the contract (`availableToSell`, `backorderId`, `currentPriceCents`,
 * `status`).
 */
export const BACKORDER_ERROR_STATUS = {
  // 400
  INVALID_BACKORDER_REQUEST: 400,
  // 404
  PRODUCT_NOT_FOUND: 404,
  VARIANT_NOT_FOUND: 404,
  SOURCE_DECISION_NOT_FOUND: 404,
  CUSTOMER_NOT_FOUND: 404,
  CHATBOT_REQUEST_NOT_FOUND: 404,
  BACKORDER_NOT_FOUND: 404,
  // 409
  STOCK_AVAILABLE_NOW: 409,
  BACKORDER_DUPLICATE: 409,
  PRICE_OUT_OF_DATE: 409,
  SOURCE_DECISION_NOT_ESTIMATED: 409,
  CUSTOMER_PHONE_AMBIGUOUS: 409,
  IDEMPOTENCY_KEY_IN_FLIGHT: 409,
  IDEMPOTENCY_KEY_CONFLICT: 409,
  BACKORDER_NOT_CANCELLABLE: 409,
  // 422
  VARIANT_REQUIRED: 422,
  VARIANT_NOT_OF_PRODUCT: 422,
  PRICE_UNAVAILABLE: 422,
  // 503
  BACKORDER_RETRY_REQUIRED: 503,
} as const;

export type BackorderErrorCode = keyof typeof BACKORDER_ERROR_STATUS;

/** Detail members the contract allows next to the code. */
export type BackorderErrorDetails = Partial<{
  availableToSell: number | null;
  backorderId: string;
  currentPriceCents: number;
  status: string;
}>;

export class BackorderError extends Error {
  readonly status: number;

  constructor(
    readonly code: BackorderErrorCode,
    readonly details: BackorderErrorDetails = {},
  ) {
    super(code);
    this.name = 'BackorderError';
    this.status = BACKORDER_ERROR_STATUS[code];
  }
}
