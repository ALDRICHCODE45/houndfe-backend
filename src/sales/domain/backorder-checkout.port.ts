/**
 * restock-backorder / T3 (contract v1 §7) — the seam between the bot checkout
 * (`SalesService.confirmBotSale`) and the backorder module.
 *
 * `BackordersModule` imports `SalesModule` (it prices through
 * `SalesService.previewBotPricing`), so the sales side cannot depend on the
 * backorder module: it only knows these interfaces. The backorder module binds
 * the implementation at startup (`BackorderCheckoutRegistry`, provided by
 * `ChatbotApiModule`, which both sides already import).
 */

/** HTTP status of every code a checkout line with `backorderId` can be refused with. */
export const BACKORDER_CHECKOUT_ERROR_STATUS = {
  BACKORDER_NOT_FOUND: 404,
  BACKORDER_NOT_RESERVED: 409,
  BACKORDER_RESERVATION_EXPIRED: 409,
  /** The reserved lot expired and valid stock cannot replace it (owner Q6). */
  BACKORDER_RESERVATION_LOST: 409,
  /** RESERVED but the journal holds nothing for it (a data fault; logged). */
  BACKORDER_RESERVATION_UNAVAILABLE: 409,
  BACKORDER_MISMATCH: 409,
  PRICE_OUT_OF_DATE: 409,
} as const;

export type BackorderCheckoutErrorCode =
  keyof typeof BACKORDER_CHECKOUT_ERROR_STATUS;

/** The detail members the contract allows next to the code. */
export type BackorderCheckoutErrorDetails = Partial<{
  status: string;
  field: 'customerId' | 'productId' | 'variantId' | 'quantity';
  currentPriceCents: number;
}>;

export class BackorderCheckoutError extends Error {
  readonly status: number;

  constructor(
    readonly code: BackorderCheckoutErrorCode,
    readonly details: BackorderCheckoutErrorDetails = {},
  ) {
    super(code);
    this.name = 'BackorderCheckoutError';
    this.status = BACKORDER_CHECKOUT_ERROR_STATUS[code];
  }
}

/** One checkout line that confirms a backorder. */
export interface BackorderCheckoutLine {
  backorderId: string;
  productId: string;
  variantId?: string | null;
  quantity: number;
  unitPriceCents: number;
}

/** What one checkout transaction needs from the backorders it confirms. */
export interface BotBackorderCheckout {
  /**
   * Plain reads, no locks: every refusal of §7 (404, NOT_RESERVED, EXPIRED,
   * MISMATCH, price) before the sale is priced. Returns the frozen unit price
   * (`finalPriceCents`) of each backorder.
   */
  inspect(now: Date): Promise<ReadonlyMap<string, number>>;
  /**
   * Under the journal locks (every product of the cart first, in id order),
   * then the backorder rows (id order): re-validates the reservation (an
   * expired lot is swapped, or the reservation is lost) and re-applies the
   * rules of `inspect` to the locked rows. Throws a `BackorderCheckoutError`.
   * Must run right before the stock charge, after every other lock of the
   * confirmation (promotion capacity, shipping quote), so the global lock
   * order stays sale → … → products → lots → variants → backorder rows.
   */
  lockAndVerify(now: Date): Promise<void>;
  /** RESERVED → CONFIRMED with the sale (rows are locked since `lockAndVerify`). */
  markConfirmed(saleId: string, confirmedAt: Date): Promise<void>;
}

/** Binding of the backorder module, used by the checkout service. */
export interface BackorderCheckoutPort {
  /**
   * Own short transactions (one per backorder) OUTSIDE the checkout one (owner
   * Q6: never sell an expired lot): swaps expired lots or sends the reservation
   * back to WAITING and commits that, with its `backorder.reservation_lost` feed
   * item, so a refused checkout cannot roll it back. Only live reservations are
   * touched. Returns the backorder that was lost (the first by id), or `null`.
   */
  settleExpiredLots(backorderIds: string[]): Promise<string | null>;
  /** The per-checkout handle passed to `SalesService.confirmBotSale`. */
  forCheckout(input: {
    customerId: string;
    lines: BackorderCheckoutLine[];
    /** Every product of the cart (lock order: all of them before any backorder row). */
    productIds: string[];
  }): BotBackorderCheckout;
}
