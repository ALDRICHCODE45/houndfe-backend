# Quote the customer's price before creating a bot order

`POST /chatbot-api/pricing/evaluate-cart` now chooses the base price in the backend, using the same transient sale, repricing and bot-eligible promotion engine as `POST /chatbot-api/sales` and [atomic checkout](chatbot-atomic-checkout.md). The bot must use the returned **pre-discount** `unitPriceCents`, not require it to match its submitted price.

## Quick path

1. Send the trusted application's sender phone with the cart. Do not accept customer identity from model-generated input. Service authentication owns the tenant; no tenant or customer ID is accepted in this request.
2. For `fully_evaluated`, display the returned prices and discounts. Use each returned `unitPriceCents` in the sale/checkout item.
3. Send `expectedTotalCents = sum(items[].finalPriceCents) + approved shipping charge`, if any. A changed price/promotion/capacity can still require a fresh quote (`PROMO_RE_QUOTE`).
4. For `needs_human_review`, stop automatic promotional checkout and request human review. Returned amounts are backend base prices with no discounts, not a promise that confirmation will omit promotions.

Existing Bearer service authentication, `pricing:evaluate` scope, branch checks, rate limits and audit behavior remain in place. This endpoint does not create customers, reserve capacity, save sales, change stock, allocate folios or publish sale events. Existing authentication/audit telemetry can still write.

## Request

HTTP POST `/chatbot-api/pricing/evaluate-cart`:

```json
{
  "phoneCountryCode": "52",
  "phone": "5512345678",
  "items": [
    {
      "productId": "a8fdbf81-31ee-4f43-8739-0c70c9388d72",
      "quantity": 1,
      "unitPriceCents": 1000
    }
  ]
}
```

| Field | Contract |
| --- | --- |
| `items` | Same required, nonempty item array as before. |
| `items[].productId` | UUID. |
| `items[].variantId` | Optional UUID; omitted/null means no variant. |
| `items[].quantity` | Positive integer, as before. |
| `items[].unitPriceCents` | Required nonnegative integer, as before, but **informational only**. Ignored for pricing, even if it differs from the backend price. |
| `phoneCountryCode` | Optional string matching `^[0-9]{1,10}$`. |
| `phone` | Optional string matching `^[0-9]{1,20}$`. |

Send both phone fields or neither. A single field, null, punctuation, whitespace or a non-digit value produces the standard class-validator HTTP 400 envelope (`statusCode`, `message` array, `error: "Bad Request"`). Nothing is trimmed or normalized; leading zeroes are preserved. These rules match [checkout discovery](chatbot-checkout-context.md).

## Response

HTTP 201, illustrating a customer whose list price is 800 cents and whose eligible promotion is 20%:

```json
{
  "items": [
    {
      "productId": "a8fdbf81-31ee-4f43-8739-0c70c9388d72",
      "variantId": null,
      "quantity": 1,
      "unitPriceCents": 800,
      "originalPriceCents": 800,
      "finalPriceCents": 640,
      "appliedPromotionTitle": "20% off",
      "discountAmountCents": 160
    }
  ],
  "promotionEvaluationStatus": "fully_evaluated",
  "customerResolution": "unique"
}
```

Items retain input order and quantity. `unitPriceCents` is the backend-chosen base **before** promotion discount; `originalPriceCents = unitPriceCents × quantity`; `finalPriceCents` is the post-line-discount total; `discountAmountCents = originalPriceCents − finalPriceCents`. Percentage discounts round per unit, just as confirmation does. `appliedPromotionTitle` is the applied line title or null. Do not submit the discounted unit price as the sale's base.

`customerResolution` is additive:

| Value | Lookup and pricing |
| --- | --- |
| `unique` | Exactly one tenant-scoped exact phone match; use its customer price list, or PUBLICO when it has no list. |
| `not_found` | No match; use PUBLICO. A subsequently created `createIfAbsent` customer has no list and uses the same PUBLICO baseline. |
| `ambiguous` | At least two matches; do not choose newest/first. Quote PUBLICO. Checkout still rejects ambiguous identity. |
| `not_provided` | Neither phone field supplied; quote PUBLICO without customer lookup. |

Only two customer rows are read. Read failures remain failures, never `not_found`. A customer disappearing between resolution and pricing also fails rather than guessing a different identity.

The bound customer list is repriced with confirmation's tier logic. Existing repricing leaves a line's seed untouched if that list has no matching product/variant row. The quote therefore seeds that case from backend PUBLICO pricing; confirmation preserves that returned base when the bot resubmits it. If neither the bound list nor PUBLICO has a catalog price, pricing fails with `PRICE_OUT_OF_DATE` instead of trusting the informational input or inventing a free item.

## Promotion safety and parity boundary

`promotionEvaluationStatus` remains `fully_evaluated | needs_human_review`. An incomplete bot-eligible snapshot, unsupported eligible promotion, applied order-level promotion, or applied non-per-unit BXGY/ADVANCED reward fails the whole cart closed. Every review line retains its **repriced** base but has `finalPriceCents = originalPriceCents`, zero discount and null title. Unsupported non-bot-eligible promotions do not block the cart.

For fully evaluated quotes, unchanged customer/catalog/promotion state and the same items yield the same merchandise total and discount on confirmation. Both paths use one `SalesService` helper; confirmation alone validates live submitted prices and performs business writes. Quotes do not reserve prices, stock or promotion capacity. Always carry `expectedTotalCents` to detect drift; it is required for checkout and for charged shipping on legacy sales.

Confirmation's existing validation against **any applicable live list price** is intentionally unchanged. Restricting it to only the customer's list would reject legacy public-price submissions and the missing-customer-list-row public fallback, even when recomputation can charge the correct quoted amount. Such tightening needs an explicit fallback policy and bot rollout; it is not part of this contract change.

## Verification scope

Mocked unit tests exercise the real `SalesService` and promotion evaluator for customer list 800 (with/without 20%), no-list and newly created customer PUBLICO 1000, missing-list-row fallback, and preview-to-confirmation totals/discounts. They also cover DTO/HTTP validation, all customer resolutions, repriced review amounts, unsupported reward flags, duplicate input order, rounding and absence of preview business writes.

The existing PostgreSQL checkout fixture stubs `recomputePricingAndPromotions`; extending it would not prove real pricing parity. This change instead proves pricing through the actual shared confirmation path that checkout calls. No database or production operation is needed for these tests.

## Errors

| HTTP | `error` | When |
| --- | --- | --- |
| 400 | `Bad Request` (class-validator envelope) | Invalid body, or only one of `phoneCountryCode`/`phone`. |
| 400 | `DUPLICATE_CART_LINE` | The same product/variant appears in more than one line. Merge quantities into one line: confirmation validates each submitted line's quantity tier before stacking repeated lines, so a quote of stacked quantities could promise a tier the sale rejects. |
| 404 | `CUSTOMER_NOT_FOUND` | The uniquely resolved customer disappeared between resolution and pricing. Retry the quote. |
| 409 | `PRICE_OUT_OF_DATE` | A product has no catalog price in the bound list nor in PUBLICO (also returned for an unknown product). |
