# POS — restock backorders («pedidos por reposición»): staff list, detail and cancel

**Status:** T5a implemented on `feat/restock-backorder` (staff API, CASL subject `Backorder`, seed grants, notification item shape), **not merged, not pushed, not deployed**. The stock fields, the counter error and the variant block (T5b) are a separate section below that the parent fills in. Task: `odd/tasks/restock-backorder.md` (T5a, S1 §9.1–§9.3 §9.5, S2 D7, log L2 and L13). Contract: `docs/proposals/restock-backorder-contract.md` v1 §9; the bot side is `docs/chatbot-handoff/restock-backorder-bot-contract.md`.

Shapes come from the code and its specs (real PostgreSQL): `src/backorders/presentation/backorders-staff.controller.ts`, `src/backorders/application/backorders-staff.service.ts`, `src/backorders/domain/backorder-staff-query.ts`, `src/backorders/presentation/dto/backorder-staff.response.ts`, `src/backorders/backorders-staff.integration.spec.ts`. Nothing was sent to the dev API.

## What it is

A WhatsApp customer asks for a product that is out of stock; the bot schedules a backorder with the staff's restock estimate. When stock arrives the backend **reserves** it for the customer (first come, first served, whole quantities) and the customer has **24 h** to confirm through the bot checkout and pay at the store. This document is the POS side: see the queue, open one, and **cancel** a `WAITING` or `RESERVED` backorder. Staff cannot create backorders in v1.

Backorder `status` (it is **not** the sale status): `WAITING` (in the queue) → `RESERVED` (stock held, 24 h) → `CONFIRMED` (became a sale) | `EXPIRED` (24 h without confirming, terminal) | `CANCELLED` (terminal). Note the spelling: the backorder is `CANCELLED` (two L) and the sale it may point at is `CANCELED` (one L, §2).

## 1. Permissions

CASL subject **`Backorder`**, actions `read` and `update` (registered in `src/auth/authorization/domain/permission.ts:959`; `create`, `delete` and `manage` do not exist for it).

| Route | Needs |
| --- | --- |
| `GET /backorders`, `GET /backorders/:id` | `read:Backorder` |
| `POST /backorders/:id/cancel` | `update:Backorder` |
| Receive the staff notices (§6) | `read:Backorder` (a `manage` or `all` grant counts too) |

Seeded roles (`prisma/seed.ts:1368`, `:1387`): **Manager** `read` + `update`, **Cashier** `read` only. So `manager@houndfe.com` (Sucursal Centro) can list, open and cancel; `cashier@houndfe.com` can list and open but gets `403` on cancel. Hide the «Cancelar pedido» button without `update:Backorder`.

**Existing databases:** the two `permissions` rows are upserted on every backend boot, but the **role grants only come from `prisma db seed`**. A database that was seeded before this change (the dev API on :3003 included) has no `Backorder` grant on any role until the grants are added; only the super admin (`manage:all`) sees the screen. Whoever deploys must add them (see the deploy note in `docs/chatbot-handoff/restock-backorder-bot-contract.md`, «Deploy checklist (T5a)»).

Every route runs `JWT → tenant context → permissions` (`src/backorders/presentation/backorders-staff.controller.ts:56`). The **sucursal is the token's**: never send a tenant, and a backorder of another sucursal is `404`, exactly like an unknown id. A super admin without a selected sucursal gets `403` (`src/shared/prisma/tenant-prisma.service.ts:135`): switch tenant first. All responses carry `Cache-Control: no-store` (a backorder changes state by itself: reservation, expiry, queue position).

## 2. `GET /backorders` — the list (§9.1)

`src/backorders/presentation/backorders-staff.controller.ts:62`, service `src/backorders/application/backorders-staff.service.ts:84`, query parsing `src/backorders/domain/backorder-staff-query.ts:107`.

| Query param | Meaning |
| --- | --- |
| `page` | 1-based integer, default `1`. A page beyond the end answers `items: []` with the real `total`. |
| `limit` | 1 to **100**, default **20** (`backorder-staff-query.ts:18-19`). Above 100 is a `400`, not clamped. |
| `status` | Comma list of `WAITING,RESERVED,CONFIRMED,EXPIRED,CANCELLED` (exact upper case, repeats ignored). Absent = every status. |
| `productId`, `variantId`, `customerId` | UUIDs. A value that is not a UUID is a `400`. |
| `q` | Free text, ≤ 100 characters, trimmed. Split on spaces (at most 5 words) and **every word must match**; a word matches the customer's first or last name, the product name, the variant name (all case-insensitive, «contains»), and a word with digits also the customer's phone digits or country code, so `+52 5512345678` works. A word like `18` can therefore match both a phone and a product name. `src/backorders/infrastructure/backorder-staff-list.query.ts:29`. |
| `from`, `to` | Bounds on `scheduledAt`, **both inclusive**, ISO 8601 **with a zone** (`2026-11-01T00:00:00-06:00` or `…Z`; a date without a time or zone is a `400`). `from` after `to` is a `400`. A `+` in an offset must be URL-encoded as `%2B`. |
| `sortBy` | `scheduledAt` (default), `status` (enum order: WAITING, RESERVED, CONFIRMED, EXPIRED, CANCELLED) or `reservedUntil` (backorders with no reservation always last, in both directions). |
| `sortOrder` | `asc` (default) or `desc`. Ties always break by queue order (`scheduledAt` asc, then id), so pages never repeat or skip a row. |

An empty value (`?status=&q=`) counts as absent. Unknown params, repeated params (`?page=1&page=2`) and bad values answer `400 INVALID_BACKORDER_REQUEST` (§7).

Response `200`:

```json
{
  "items": [ /* BackorderStaff, §3 */ ],
  "page": 1,
  "limit": 20,
  "total": 37,
  "counts": { "WAITING": 21, "RESERVED": 4, "CONFIRMED": 9, "EXPIRED": 2, "CANCELLED": 1 }
}
```

- `total` is the number of rows that match **all** the filters, including `status`: use it for the pager.
- `counts` honours **every filter except `status`** (product, variant, customer, `q`, `from`/`to`): use it for the status tabs/chips so they keep their numbers while a status is selected. All five keys are always present (0 when none).
- The default order is the queue order (oldest first), so on a `WAITING` list `queuePosition` goes 1, 2, 3… per product/variant.

## 3. `GET /backorders/:id` and the `BackorderStaff` shape (§9.2)

`src/backorders/presentation/backorders-staff.controller.ts:77`. Same object as a list item. `404 BACKORDER_NOT_FOUND` for an unknown, malformed or other-sucursal id (§7).

```json
{
  "id": "8f0c2b6e-3a41-4f9d-9d52-6a1b7c9e0d11",
  "folio": "BO-000012",
  "status": "WAITING",
  "version": 1,
  "productId": "5c1e9a02-77d4-4b8a-a1f3-0e2d4c6b8a90",
  "productName": "Croquetas Adulto Raza Grande 18 kg",
  "productImageUrl": "https://…/croquetas.png",
  "variantId": null,
  "variantName": null,
  "quantity": 2,
  "referencePriceCents": 114900,
  "priceListId": null,
  "currentPriceCents": null,
  "finalPriceCents": null,
  "scheduledAt": "2026-11-20T15:00:00.000Z",
  "estimatedAt": "2026-11-27T15:00:00.000Z",
  "estimatedArrivalDays": 7,
  "reservedAt": null,
  "reservedUntil": null,
  "reminderAt": null,
  "queuePosition": 2,
  "saleId": null,
  "saleStatus": null,
  "sourceDecisionId": "b4d1…",
  "chatbotRequestId": null,
  "origin": "CHATBOT",
  "confirmedAt": null,
  "cancelledAt": null,
  "expiredAt": null,
  "cancelledBy": null,
  "cancelledByKind": null,
  "cancelReason": null,
  "etaOverdue": false,
  "passedOverCount": 3,
  "branchName": "Centro",
  "customerFirstName": "Rosa",
  "phoneCountryCode": "52",
  "phone": "5512345678",
  "customer": { "id": "2a7f…", "name": "Rosa Gómez", "phone": "+525512345678" }
}
```

Type: `src/backorders/presentation/dto/backorder-staff.response.ts:44`. All timestamps are ISO 8601 **UTC** (`…Z`): render them in the sucursal time zone.

| Field | Meaning |
| --- | --- |
| `status` | `WAITING`, `RESERVED`, `CONFIRMED`, `EXPIRED`, `CANCELLED`. |
| `version` | Optimistic-concurrency token: send it back as `version` in the cancel (§4). It changes on every state change (reservation, ETA update, cancel…), so a list that is minutes old usually holds a stale one. |
| `quantity` | Whole units. |
| `referencePriceCents` | Unit price when it was scheduled (customer's price list, before promotions). `priceListId` is the customer's price list that produced it, `null` = the public list. |
| `currentPriceCents`, `finalPriceCents` | Set **when it becomes `RESERVED`**: that day's unit price with automatic promotions, and `min(reference, current)` (what the customer will pay). `null` while `WAITING`. Cents, MXN. |
| `scheduledAt` | When it joined the queue (queue order key). |
| `estimatedAt`, `estimatedArrivalDays` | Staff's restock estimate (a human estimate, «aproximadamente»). |
| `reservedAt`, `reservedUntil`, `reminderAt` | The 24 h window (`reservedUntil = reservedAt + 24 h`; the customer reminder goes out 3 h before). `null` unless the backorder is/was `RESERVED`. |
| `queuePosition` | 1-based position among the `WAITING` backorders **of the same product/variant**; `null` in every other status. |
| `passedOverCount` | How many times later backorders were reserved while this one (the head of its queue) kept waiting because its whole quantity did not fit (owner Q1). Show a «le pasaron N pedidos» flag when `> 0` and `status === "WAITING"`. |
| `etaOverdue` | `true` only when `WAITING`, the overdue-ETA re-estimate was **already answered** (the customer got a new date) **and** that new `estimatedAt` is in the past too. Highlight it: nothing else will be asked automatically. |
| `saleId`, `saleStatus`, `confirmedAt` | Set when `CONFIRMED` (the customer confirmed through the bot checkout and a sale exists). `saleStatus` is the **sale's own status enum** (`SaleStatus`: `DRAFT`, `CONFIRMED`, `CANCELED` — one L, the same values as `status` on `GET /sales/:id`, `prisma/schema.prisma` `enum SaleStatus`). It can change after confirmation (the sale may be cancelled later), so read it, do not infer it from `status`. `null` while there is no sale. Open the sale with `saleId`. |
| `expiredAt` | Set when `EXPIRED`. |
| `cancelledAt`, `cancelledByKind`, `cancelReason`, `cancelledBy` | Set when `CANCELLED`. `cancelledByKind` is `CUSTOMER` (cancelled from the chat: `cancelledBy` is `null`) or `STAFF` (`cancelledBy` is `{ "id", "name" }` of the user, or `null` if that user was deleted since). `cancelReason` ≤ 280 characters, may be `null`. |
| `origin` | Always `"CHATBOT"` in v1 (no staff creation). |
| `chatbotRequestId` | The chatbot request that carried it, when the bot created it through the requests route; `null` otherwise. |
| `productImageUrl` | The variant's image, else the product's main image, else `null`. |
| `sourceDecisionId` | The RESTOCK decision that gave the estimate. |
| `customer.phone` | The customer's full international number (`+525512345678`), `null` if they have none. **Not masked**: the Cashier needs it to phone the customer when the bot could not reach them (§6). `phoneCountryCode` + `phone` at the top level are the same number split (national part), kept because this object extends the bot's `BackorderBot`. |
| `customer.name` | First and last name joined (`Rosa Gómez`), last name omitted when empty. |
| `branchName`, `customerFirstName` | Bot-projection fields, kept as they are. |

A variant backorder has `variantId` and `variantName` (e.g. `"Bolsa 5 kg"`); a simple product has both `null`.

## 4. `POST /backorders/:id/cancel` — staff cancel (§9.3)

`src/backorders/presentation/backorders-staff.controller.ts:95`, service `src/backorders/application/backorders-staff.service.ts:129`. Needs `update:Backorder`. Answers **`200`** with the cancelled `BackorderStaff`.

```http
POST /backorders/8f0c2b6e-3a41-4f9d-9d52-6a1b7c9e0d11/cancel
Content-Type: application/json

{ "reason": "Producto descontinuado", "version": 3 }
```

| Field | Rules |
| --- | --- |
| `version` | **Required**, integer ≥ 1: the `version` of the backorder as the screen last read it. |
| `reason` | Optional, string ≤ 280 characters (trimmed; blank or `null` is stored as `null`). It is sent to the customer's bot (`backorder.cancelled_by_staff`), so the bot may quote it: ask for a customer-safe reason. |

Any other field in the body is a `400`. There is **no** `Idempotency-Key`: a double click is safe, because the second request finds the backorder already `CANCELLED` and answers `409 BACKORDER_NOT_CANCELLABLE {status: "CANCELLED"}` without moving anything.

What it does, in **one transaction**:

- only `WAITING` and `RESERVED` can be cancelled; the row becomes `CANCELLED` with `cancelledByKind: "STAFF"`, `cancelledBy` = the caller, `cancelledAt`, `cancelReason`, `version + 1`;
- a `RESERVED` backorder **releases its units** (they go back to the sellable stock, journal movement `BACKORDER_RELEASE`, actor = the caller's name) and the **next `WAITING` backorder of the same product/variant that fits is reserved with them right away** (so a different backorder may flip to `RESERVED` as a result: refresh the list, do not patch only the cancelled row);
- the bot is told: feed item `backorder.cancelled_by_staff` (`docs/chatbot-handoff/restock-backorder-bot-contract.md` §10), exactly once.

Check the result: `status === "CANCELLED"`, `version` is the old one + 1.

## 5. Concurrency and what to do on each `409`

Staff cancel, the 30-second sweep (reminder, 24 h expiry), the bot's checkout, the customer's own cancel and stock arrivals can all touch the same backorder. The backend serialises them (stock first, then the backorder row); exactly one wins and the others get a clean `409`. **On any `409`: reload that backorder (`GET /backorders/:id`), show its new state and let the user decide again.**

The status is checked **before** the version: a backorder that already ended answers `BACKORDER_NOT_CANCELLABLE` (with its status) whatever `version` you sent, so you can tell the user *why* («ya fue confirmado»). `VERSION_CONFLICT` therefore always means «still cancellable, but it changed» (for example it was just reserved, or its ETA was updated).

## 6. Staff notices (§9.5): types and where `backorderId` is

Notices arrive through the **existing notifications API** (`GET /notifications`, `GET /notifications/unread-count`, realtime `notification.created`; see `docs/frontend-handoff/13-notifications.md` and `17-realtime-sse.md`). Nothing new to call. They are **in-app only** (no email).

| `type` | When | Who gets it | Dedup |
| --- | --- | --- | --- |
| `BACKORDER_RESERVED` | Stock arrived and a backorder became `RESERVED` (the 24 h start) | Every active member of the sucursal with `read:Backorder` | One per backorder **version**: a re-reservation after a lost reservation is a new notice |
| `BACKORDER_EXPIRED` | A `RESERVED` backorder lapsed after 24 h unconfirmed | Same | One per backorder (`EXPIRED` is terminal) |
| `BACKORDER_NOTICE_UNDELIVERED` | The bot could **not deliver** the «apartado» notice or its reminder to the customer (provider rejected it): **phone the customer** before the 24 h run out | Same | One per failed delivery |

Recipients are resolved by `read:Backorder` (`src/notifications/domain/backorder-notice.ts:33`, `src/notifications/infrastructure/notice-recipients.ts:110`): with the seed that is every Manager and Cashier of the sucursal, plus any member holding `manage` or `all`; an inactive user, a member of another sucursal and a user with only `update:Backorder` are not notified (`src/backorders/backorders-staff.integration.spec.ts`, «staff notice recipients»).

The item is the standard notification view with **`backorderId` filled** (`src/notifications/domain/notification-view.ts:50`, built at `:151`). `requestId` and `saleId` are `null`, `folio` is the backorder folio (`BO-000012`, **not** a sale folio), and the other request-notice fields are `null`:

```json
{
  "id": "6f1d3a2e-0b7c-4e55-9a31-2c7d8e9f0a1b",
  "type": "BACKORDER_RESERVED",
  "title": "Pedido por reposición apartado",
  "body": "Pedido BO-000012 · 2 × Croquetas Adulto Raza Grande 18 kg",
  "requestId": null,
  "saleId": null,
  "backorderId": "8f0c2b6e-3a41-4f9d-9d52-6a1b7c9e0d11",
  "folio": "BO-000012",
  "subtype": null,
  "cause": null,
  "reason": null,
  "requestOpen": null,
  "level": null,
  "createdAt": "2026-11-21T15:00:00.000Z",
  "readAt": null
}
```

| `type` | `title` | `body` |
| --- | --- | --- |
| `BACKORDER_RESERVED` | `Pedido por reposición apartado` | `Pedido BO-000012 · 2 × <producto>` (` (<variante>)` after the product for a variant backorder) |
| `BACKORDER_EXPIRED` | `Apartado de pedido por reposición vencido` | same |
| `BACKORDER_NOTICE_UNDELIVERED` | `No se pudo avisar al cliente de su pedido por reposición` | same + ` · Llámale para que confirme antes de que venza el apartado` |

(`src/notifications/domain/backorder-notice.ts:101`.) Switch on `type`, never on `title`/`body`. `backorderId` is `null` on every request and sale notice, so `backorderId !== null` is a safe test for «this is a backorder notice». Open the detail with `GET /backorders/:id` for the current state and the customer's phone (`customer.phone`); the provider's refusal reason is **not** in the item. The frontend already links these types to `/pos/pedidos-reposicion/:id`.

## 7. Errors: exact status and body

New-module envelope, **detail members at the root of the body** (the same shape as the sale-hold errors `HOLD_VERSION_CONFLICT`, `src/sales/sale-hold.service.ts:15`; built by `src/backorders/presentation/backorder-http-error.ts:15`): `{ "statusCode", "error", "message", …detail }` where `message` repeats `error`. There is **no `timestamp` and no `details` wrapper**. Switch on `error`.

| Status | Body | When |
| --- | --- | --- |
| `404` | `{ "statusCode": 404, "error": "BACKORDER_NOT_FOUND", "message": "BACKORDER_NOT_FOUND" }` | Unknown id, a malformed id (not a UUID) or a backorder of another sucursal. On every route. |
| `409` | `{ "statusCode": 409, "error": "BACKORDER_NOT_CANCELLABLE", "message": "BACKORDER_NOT_CANCELLABLE", "status": "CONFIRMED" }` | Cancel of a backorder that is not `WAITING`/`RESERVED`. `status` is its current status: `CONFIRMED`, `EXPIRED` or `CANCELLED`. Checked before the version. |
| `409` | `{ "statusCode": 409, "error": "VERSION_CONFLICT", "message": "VERSION_CONFLICT", "currentVersion": 4 }` | Cancel with a `version` that is not the current one, on a still-cancellable backorder. Nothing was changed. Retry only after reloading (you may use `currentVersion` once the user confirmed on the fresh state). |
| `400` | `{ "statusCode": 400, "error": "INVALID_BACKORDER_REQUEST", "message": "INVALID_BACKORDER_REQUEST" }` | A bad list query (§2) or cancel body (§4: missing/invalid `version`, `reason` over 280, unknown field). The body never says which field. |
| `503` | `{ "statusCode": 503, "error": "BACKORDER_RETRY_REQUIRED", "message": "BACKORDER_RETRY_REQUIRED" }` | The database could not serialise the cancel (rare transient conflict or timeout). Nothing was changed: retry the same request once. |
| `401` | `{ "statusCode": 401, "message": "Unauthorized" }` | No or invalid token. |
| `403` | `{ "statusCode": 403, "error": "INSUFFICIENT_PERMISSIONS", "message": "Insufficient permissions", "timestamp": "2026-11-20T21:00:00.000Z" }` | Missing `read:Backorder` (reads) or `update:Backorder` (cancel). This one is the app-wide permission envelope (it carries `timestamp`). |

Where each is raised: `src/backorders/domain/backorder-error.ts:11` (`INVALID_BACKORDER_REQUEST`), `:18` (`BACKORDER_NOT_FOUND`), `:27` (`BACKORDER_NOT_CANCELLABLE`), `:29` (`VERSION_CONFLICT`), `:35` (`BACKORDER_RETRY_REQUIRED`); in `src/backorders/application/backorders-staff.service.ts:168` and `:173`. `403` is `src/shared/filters/domain-exception.filter.ts:48`. All bodies above are asserted in `src/backorders/backorders-staff.integration.spec.ts`.

## 8. What the screen needs, in short

- List: tabs from `counts` (status filter = `status` param), search box = `q`, optional date range = `from`/`to`, pager from `total`/`page`/`limit`. Default order is the queue; offer «Vence pronto» = `sortBy=reservedUntil`.
- Row: `folio`, `customer.name` + `customer.phone`, product/variant + `quantity`, `status`, `queuePosition` (WAITING), `reservedUntil` countdown (RESERVED), `estimatedAt` (with the `etaOverdue` flag), `passedOverCount` flag.
- Detail: the same plus `finalPriceCents`/`referencePriceCents`, `saleId` link (`saleStatus` badge), cancel info.
- Cancel: only for `WAITING`/`RESERVED` and with `update:Backorder`; confirm dialog (for `RESERVED` say that the units go to the next customer in the queue); send `version`; on `409` reload.
- Notifications: link `BACKORDER_*` items to the detail by `backorderId`.

## Stock fields, counter error and variant block (T5b)

> **PLACEHOLDER — the parent fills this section from T5b's work.** It must answer the open questions of log L2 and L13: (1) exact endpoints and JSON level (product, variant or both) of `stockOnHand` / `reservedForBackorders` / `availableToSell` (`GET /products`, `GET /products/:id`, `GET /products/:id/variants`, the POS search route); (2) the exact body of `STOCK_RESERVED_FOR_BACKORDER {available, reserved}`, which confirm route raises it and the add-item warning shape; (3) the variant-conversion block (which request — create the first variant or convert a product to variants —, the error code and body); (5) the publish order on :3003; and the dev showcase script with sample backorders in every state (L13 (4)).
