# Branch location — bot contract (A1)

Roadmap proposal #12: the bot tells the customer where and when to pick up an order, with a WhatsApp map pin. Implemented on `feat/branch-location`.

## 0. Deploy order (production)

The bot validated `pickupLocation` strictly, so the new `location` key would read every pickup checkout as contract drift. **Deploy the chatbot with commit `2fdfd8d` (location optional and nullable) first, then the backend with `ba138ae1` or later.** The backend migration is additive and can run at any point of that order.

## 1. Route

| Method | Path                  | Scope          | Success |
| ------ | --------------------- | -------------- | ------- |
| `GET`  | `/chatbot-api/branch` | `catalog:read` | `200`   |

- The tenant comes from the service credential, as on every `/chatbot-api` route. No path or query parameters.
- No new scope: the existing dev credential already works.
- `401` without a valid credential, `403` with a credential that lacks `catalog:read`.
- It is a live read. It is never cached with a sale.

## 2. Response

The same object as the checkout `pickupLocation` (`docs/chatbot-checkout-shipping.md` §3), read from the same source the POS edits:

```json
{
  "name": "Sucursal Centro",
  "address": {
    "addressLine1": "Av. Juárez 123",
    "addressLine2": null,
    "neighborhood": "Centro",
    "municipality": "Cuauhtémoc",
    "state": "Ciudad de México",
    "postalCode": "06000",
    "formatted": "Av. Juárez 123, Centro, Cuauhtémoc, Ciudad de México, C.P. 06000"
  },
  "hours": {
    "timeZone": "America/Mexico_City",
    "days": [
      {
        "day": "MONDAY",
        "label": "Lunes",
        "closed": false,
        "ranges": [{ "open": "09:00", "close": "18:00" }]
      },
      {
        "day": "TUESDAY",
        "label": "Martes",
        "closed": false,
        "ranges": [{ "open": "09:00", "close": "18:00" }]
      },
      {
        "day": "WEDNESDAY",
        "label": "Miércoles",
        "closed": false,
        "ranges": [{ "open": "09:00", "close": "18:00" }]
      },
      {
        "day": "THURSDAY",
        "label": "Jueves",
        "closed": false,
        "ranges": [{ "open": "09:00", "close": "18:00" }]
      },
      {
        "day": "FRIDAY",
        "label": "Viernes",
        "closed": false,
        "ranges": [{ "open": "09:00", "close": "18:00" }]
      },
      {
        "day": "SATURDAY",
        "label": "Sábado",
        "closed": false,
        "ranges": [{ "open": "09:00", "close": "18:00" }]
      },
      { "day": "SUNDAY", "label": "Domingo", "closed": true, "ranges": [] }
    ],
    "summary": "Lunes a sábado: 09:00–18:00. Domingo: cerrado."
  },
  "location": { "latitude": 19.432608, "longitude": -99.133209 }
}
```

| Key        | Source                                                                                  | `null` when                                               |
| ---------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `name`     | sucursal (tenant) name                                                                  | never (empty string only if the tenant has no name)       |
| `address`  | the shipping origin; without one, the free-text sucursal address (only `formatted` set) | neither exists                                            |
| `hours`    | the sucursal opening hours                                                              | not set yet                                               |
| `location` | the shipping origin map pin (WGS84 decimal degrees)                                     | no pin stored, or no shipping origin — send only the text |

## 3. Where the data is edited

All of it is edited in the POS, in one place each:

- Address and map pin: `PUT /tenants/:tenantId/shipping-origin` (`docs/frontend-handoff/10-shipping-settings-screens.md` §6). `latitude`/`longitude` are optional and sent together; omitting both keeps the stored pin, `null` in both clears it.
- Hours: `PUT /tenants/:tenantId/opening-hours` (§7 of the same doc).

## 4. Checkout `pickupLocation`

`POST /chatbot-api/checkouts` and `POST /chatbot-api/sales` with `shipping: { mode: "pickup" }` now also carry `pickupLocation.location`, with the same shape and rule. A replay of a sale created before this change has no `location` key: treat a missing key as `null`.

## 5. Production data

The backend cannot read production from here. Whether the production sucursal already has opening hours (and an origin) is answered by the owner, or by `GET /chatbot-api/branch` with the production credential once this is deployed. No production sucursal has a pin until someone sets it.
