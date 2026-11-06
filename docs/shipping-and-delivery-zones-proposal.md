# Shipping quotes and delivery zones in the backend (PROPOSAL)

**Status: proposal for the owner's OK. Nothing here is implemented.** Today the chatbot quotes Skydropx itself (`houndfe-chatbot/src/shipping/**`) and every shipping charge waits for a human approval (`shipping.chargeCents` + `approvalId` in `POST /chatbot-api/checkouts` and `POST /chatbot-api/sales`). The owner decided to move all shipping logic to the backend (2026-11-05).

## 1. Decisions already taken

| # | Decision |
| --- | --- |
| 1 | Carriers: Envíos Perros and Skydropx. Always use the **cheapest** option. |
| 2 | Delivery zones are per postal code and validated from the system, by users with a permission. |
| 3 | Approving a zone decides everything at once: whether it is delivered, its type (FREE, SURCHARGE, CARRIER_ONLY, DENIED) and the cost when SURCHARGE. |
| 4 | One package per order: add up the package weights and use the smallest configurable standard box that fits. |
| 5 | No human approval per shipping charge: the backend signs a quote with an expiry, and the sale uses it. |
| 6 | Shipping credit: $120 MXN per **unit** whose unit price after discounts is above $500. Credits add up. The customer pays `max(0, cost − credit)`. |

## 2. What the system stores

| Data | Where | Edited by |
| --- | --- | --- |
| Package weight (g) and dimensions (cm) of the packed item | Per product, overridable per variant | Store UI («Empaque»). Not the editorial net weight. |
| Standard boxes: name, inner dimensions, own weight, max weight | Per sucursal | Store UI |
| Origin address and postal code of the sucursal | Per sucursal (today `Tenant.address` is free text, without a postal code) | Store UI |
| Delivery zones: postal code, type, surcharge, who approved and when | Per sucursal | Store UI, permission `DeliveryZone:validate` |
| Carrier credentials (Envíos Perros token, Skydropx client id/secret) | Backend environment variables, never in the DB or the UI | Operator |
| Shipping quotes: items, destination, chosen carrier option, cost, credit, customer charge, expiry | Per sucursal, read-only | Backend |

## 3. Zone types

| Type | Meaning for the customer |
| --- | --- |
| `FREE` | Own delivery at no cost. |
| `SURCHARGE` | Own delivery with a fixed surcharge, set when the zone is approved. |
| `CARRIER_ONLY` | Only by parcel carrier; the cheapest carrier quote applies (minus the credit). |
| `DENIED` | Not delivered. |
| `PENDING` | Unknown postal code waiting for validation (not a stored type: it is an open validation). |

## 4. Flow for the chatbot

1. **Quote.** `POST /chatbot-api/shipping/quotes` with `{ items: [{ productId, variantId?, quantity }], destination: { zipCode, state, municipality, neighborhood } }`.
2. The backend looks up the zone of `zipCode`:
   - `FREE` / `SURCHARGE`: answers with the zone price, no carrier call.
   - `CARRIER_ONLY`: builds the order package, asks Envíos Perros and Skydropx in parallel, keeps the cheapest option.
   - `DENIED`: answers that it is not delivered.
   - Unknown: opens a zone validation (idempotent per postal code) and answers `zoneStatus: "PENDING"`.
3. **Response:** `{ quoteId, expiresAt, zoneStatus, option: { carrier, service, etaDays } | null, costCents, creditCents, customerChargeCents, currency: "MXN" }`.
4. **Sale.** `POST /chatbot-api/checkouts` / `sales` accept `shipping: { quoteId }`. The backend checks that the quote belongs to that sucursal, has not expired, and matches the cart items and destination; then it fixes the shipping charge. `chargeCents` + `approvalId` are removed.
5. **Pending zone.** The validation is a new human-decision type `DELIVERY_ZONE`, reusing the bot cycle the chatbot already uses for restock (intake, poll, outcome ACK). Users with the permission get an email (new notification action `DELIVERY_ZONE_VALIDATION_REQUESTED`), approve or reject in the store UI choosing the type and surcharge, and the bot learns the result by polling. Approved zones serve every future customer of that postal code.

## 5. Package and quote rules

- **Package:** total weight = sum of unit package weights × quantity + box weight. Box = the smallest standard box whose inner dimensions and max weight fit the items (largest dimension of each item must fit). If no box fits, the quote fails with a clear error and the store has to add a box.
- **Missing packaging data:** a product without package weight or dimensions cannot be quoted by carrier (`PACKAGING_DATA_MISSING`, listing the products). Own delivery zones do not need packaging data.
- **Cheapest:** cheapest total cost including taxes the carrier reports. Ties: shortest ETA.
- **Credit:** computed with the unit price after discounts of the same cart pricing the sale will use.
- **Expiry:** 30 minutes by default, never beyond the carrier rate validity (Skydropx: 24 h).
- **Carrier failures:** if one carrier fails, the other one's option is used. If both fail: `SHIPPING_QUOTE_UNAVAILABLE`, the bot tells the customer and can retry.

## 6. Out of this first step

- Creating the label, pickup and tracking (later, from the store UI).
- Several packages per order.
- Zones by colony or radius (postal code only).

## 7. Prerequisites

- Carrier credentials and sandbox accounts (Envíos Perros token; Skydropx client id/secret). Without them the carriers run in a fake mode for development and tests.
- The sucursal origin postal code.
- Packaging data for the products sold by carrier.

## 8. Suggested slices

| Slice | Content |
| --- | --- |
| Z1 | Zones: storage, store endpoints + permission, `DELIVERY_ZONE` human decision, email, bot intake/poll/outcome. |
| S1 | Packaging data (product/variant), standard boxes, sucursal origin, store endpoints. |
| S2 | Quote engine: package builder, credit rule, carrier ports with fake adapters, signed quotes. |
| S3 | Skydropx adapter (credentials exist today in the chatbot: `SKYDROPX_CLIENT_ID/SECRET`, origin `SKYDROPX_ORIGIN_*`; they move to the backend). Envíos Perros adapter later, when the owner has an API token. |
| S4 | Chatbot contract: `POST /chatbot-api/shipping/quotes`, `shipping.quoteId` in checkouts/sales, retire `chargeCents`/`approvalId`. |
| S5 | FE screens (Empaque, Cajas, Zonas, Validaciones pendientes) — frontend work. |

Z1, S1 and S2 do not need carrier credentials and can start now.

## 9. Owner updates (2026-11-05, relayed by the chatbot)

- Skydropx: the owner already has an account and credentials, used today by the chatbot. They move to the backend environment.
- Envíos Perros: no API account yet. The quote engine works with **any number of configured carriers**: it asks every configured carrier and keeps the cheapest among those that answered. With only Skydropx configured, Skydropx is used. Envíos Perros is added when there is a token, with no contract change.
- Payments v1: transfer only. Payment links (EVO, Mercado Pago) come later and are out of this proposal.

## 10. Contract details agreed with the chatbot (2026-11-05)

- **Pricing for the credit:** the quote receives the customer identity (`phoneCountryCode` + `phone`, as in `pricing/evaluate-cart`) and the backend reprices the cart itself with the customer's price list and promotions. The bot never sends unit prices.
- **Destination:** either `shippingAddressId` (a saved address of that customer) or the loose fields `{ zipCode, state, municipality, neighborhood }` for a new or corrected address. Exactly one of the two.
- **Quote binding:** a quote is bound to the sucursal, the customer, the cart lines (product, variant, quantity) and the destination. At checkout/sale with `shipping.quoteId`:
  - `SHIPPING_QUOTE_NOT_FOUND`: unknown or foreign quote.
  - `SHIPPING_QUOTE_EXPIRED`: past `expiresAt`; the bot requotes silently.
  - `SHIPPING_QUOTE_MISMATCH`: the cart or the destination changed; the bot requotes and shows the new total.
- **Total:** the sale total (`totalCents`) and the debt include `customerChargeCents`, so a transfer receipt is compared against that total.
- **`DELIVERY_ZONE` intake (bot → backend):** `zipCode`, `state`, `municipality`, `neighborhood`, customer phone, a conversation reference and the time of the customer's last message (so the store UI can show urgency). **Outcome (backend → bot):** final zone status, plus surcharge and ETA when it applies.
- **FREE zone response:** `option: null`, `costCents: 0`, `creditCents: 0`, `customerChargeCents: 0`, `etaDays` from the zone.

## 11. Owner answers (2026-11-05)

- **DENIED zone:** the bot offers store pickup. The sale is registered without shipping (`shipping: { mode: "pickup" }`).
- **Credit on own-zone surcharge: TO BE CONFIRMED by the owner with their client.** Provisionally the credit applies to both the own-zone surcharge and the carrier cost. It stays one configurable rule, so switching to "carrier cost only" changes no contract.
- **Pending zone validations:** the store UI sorts them by the customer's last message time and highlights the ones close to 24 h (WhatsApp free-text window). The email states the deadline. After 24 h the bot uses its approved WhatsApp template.
- **Delivery time (decided):** a zone's usual time is not a fixed promise for every order.
  - The zone keeps its usual days, set when the zone is approved; carrier quotes bring their own ETA.
  - If an item of the order has no sellable stock now, the quote does not promise that time: it returns `eta: { days: null, reason: "STOCK_PENDING" }` and the bot uses the existing RESTOCK human decision (`restockDays`) to tell the customer; the estimate becomes `restockDays + zone days`.
  - Staff can set an adjusted estimated delivery date on a specific sale, with a reason; the bot is notified to tell the customer.
  - Purchase orders have no expected-arrival date today, so they cannot feed the estimate yet.
