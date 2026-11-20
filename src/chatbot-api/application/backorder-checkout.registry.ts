import { Injectable } from '@nestjs/common';
import type { BackorderCheckoutPort } from '../../sales/domain/backorder-checkout.port';

/**
 * restock-backorder / T3 — where the backorder module binds its checkout
 * behaviour (`BackorderCheckoutService` registers itself in its constructor,
 * like `BackorderAllocator` does with the stock journal). It lives here because
 * both sides already depend on this module: `BackordersModule` imports
 * `ChatbotApiModule`, so the checkout service cannot import the backorder
 * module, and a registration needs no lifecycle hook (the pca-5b boot harness
 * fails closed on unreviewed ones).
 *
 * Unbound (a partial test graph) a checkout with `backorderId` is refused with
 * 503 `BACKORDER_CHECKOUT_UNAVAILABLE`; one without it never asks.
 */
@Injectable()
export class BackorderCheckoutRegistry {
  private port: BackorderCheckoutPort | undefined;

  register(port: BackorderCheckoutPort): void {
    this.port = port;
  }

  get(): BackorderCheckoutPort | undefined {
    return this.port;
  }
}
