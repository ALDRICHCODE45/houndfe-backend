# Chatbot ↔ backend: customer pets («varias mascotas por cliente») — bot contract v1

**Status:** v1 approved by the chatbot and the frontend on 2026-11-23 (owner answers Q1, Q2 and D8 given directly in the backend session). Merged into local `main` (1e22fb90, 2026-11-23; push and deploy pending): the model, the pet routes and `customer.pets` in `by-phone` (T1/T2), the pet on order history (T2), and `sale.items[i].petId` in checkout (T3). Task: `odd/tasks/customer-pets.md` (S1–S3, S5–S9). Design and decisions: `docs/proposals/customer-pets-contract.md`. The POS side is `docs/frontend-handoff/27-customer-pets.md`; nothing in it is called by the bot.

Shapes below come from the code, not only from the proposal. Where the code differs from the proposal, this document follows the code (see «Differences from the proposal» at the end).

Source: `src/customer-pets/presentation/bot/customer-pets-bot.controller.ts`, `.../customer-pet-bot-create.service.ts`, `src/customer-pets/presentation/dto/customer-pet.dto.ts`, `src/customer-pets/domain/customer-pet-rules.ts`, `.../customer-pet-age.ts`, `.../customer-pet-error.ts`, `src/chatbot-api/presentation/chatbot-api.controller.ts` (`by-phone`, orders), `src/chatbot-api/presentation/checkout.controller.ts`, `src/chatbot-api/presentation/dto/checkout.request.ts`, `src/customer-pets/customer-pets-bot.integration.spec.ts`, `src/chatbot-api/checkout-pets.integration.spec.ts`, migrations `prisma/migrations/20261123000000_customer_pets` and `20261123010000_customer_pet_bot_receipt_kind`.

## 0. Owner decisions this implements

| # | Decision (as relayed) | Where |
| --- | --- | --- |
| D1 | Pets live in the backend (Customer → pets), visible and editable from the POS | §1, §2 |
| D2 | With 2+ pets and no clear recipient the bot asks with buttons (bot-side behavior; the backend gives species, breed and age) | §2 |
| D3 | History per pet («¿lo mismo de siempre para Max?») | §6 |
| D4 | Allergies and notes: warning only; the backend stores the text and does not match it against products | §1 |
| D5 | Age that advances by itself (approximate birth date, never frozen text) | §3 |
| D6 / D9 | «Bruno ya no está» / «olvida a Bruno» → **archive** (restorable); explicit «olvida mis datos» → **real deletion** | §4.5, §4.6 |
| D7 | Printed ticket: no pet in v1 (POS only) | — |
| D8 | Several active pets with the same name are allowed; the backend warns with `warnings: ["PET_NAME_DUPLICATE"]` | §1, §3 |
| D10 | At most **20 ACTIVE** pets per customer | §1 |

## 1. Scopes, model and limits

Credential: `Authorization: Bearer svc_…`. **New scopes** (add them to the chatbot credential before deploy): `pets:read`, `pets:write`, `pets:delete`. A route without its scope answers `403`; `X-Branch-Id`, when sent, must be the credential's sucursal.

| Scope | Routes |
| --- | --- |
| `pets:read` | `GET /chatbot-api/customers/:customerId/pets`; also makes `customer.pets` appear in `GET /chatbot-api/customers/by-phone` |
| `pets:write` | `POST` (create), `PATCH`, `POST …/archive`, `POST …/restore` |
| `pets:delete` | `DELETE …/:petId?version=N` (real erasure) |

`GET customers/by-phone` still needs **`customers:read`**; to receive `customer.pets` the credential needs **`customers:read` and `pets:read`**. Without `pets:read` the `pets` key is **absent** (not an empty array) and the response is exactly the previous one. The order-history route (`customers:read`) needs no pet scope: the per-line `pet` and `?petId=` work with `customers:read` alone.

Budgets: the `GET` pet route is in the `read` bucket; create, PATCH, archive, restore and DELETE are in the `write` bucket (the credential's per-class limits, `429` + `Retry-After`).

A pet belongs to one customer of the credential's sucursal.

| Field | Rule |
| --- | --- |
| `name` | required, trimmed, 1–60 characters |
| `species` | required: `DOG`, `CAT` or `OTHER` |
| `speciesOther` | ≤ 40, **required when `species` is `OTHER`**, must be empty otherwise |
| `breed` | ≤ 80, optional |
| `size` | optional: `SMALL`, `MEDIUM`, `LARGE`, `GIANT` |
| `birthDate` + `birthDatePrecision` | optional pair, see §3 |
| `allergies`, `notes` | ≤ 500 each, optional (warning only) |
| `status` | `ACTIVE` or `ARCHIVED` |
| `createdVia` | `CHATBOT` for pets you create, `POS` for staff |
| `version` | starts at 1; +1 on every write (edit, archive, restore) |

Text fields are trimmed; a blank string is stored as `null`.

- **At most 20 ACTIVE pets per customer.** Create or restore past it → `422 PET_LIMIT_REACHED`. Archived pets do not count.
- **Duplicate names are allowed** among active pets. Create, PATCH (when the name changes) and restore answer `warnings: ["PET_NAME_DUPLICATE"]` when another ACTIVE pet of the same customer has the same name (case and accents ignored, spaces collapsed); the write still succeeds. Disambiguate with species, breed and age, and always work with `id`.
- `GET …?status=ARCHIVED|ALL` is capped at **100** rows; `ACTIVE` is not capped (it cannot exceed 20).

Errors have the code-only body `{ "statusCode", "error", "message" }` with `error === message`, plus the detail member listed in the table of §9. Validation failures (`400`) use the standard per-field body (`message` is an array of `{ property, children, constraints }`, `error: "Bad Request"`). Unknown failures answer `500 CUSTOMER_PET_REQUEST_FAILED`.

## 2. Pet shape (shared by every route)

```json
{
  "id": "8d0e0f6e-5b87-4c2c-8d3a-1f6f0c7a9b11",
  "customerId": "5c1e9a02-77d4-4b8a-a1f3-0e2d4c6b8a90",
  "name": "Bruno",
  "species": "DOG",
  "speciesOther": null,
  "breed": "Chihuahua",
  "size": "SMALL",
  "birthDate": "2026-01-01",
  "birthDatePrecision": "MONTH",
  "ageMonths": 10,
  "ageLabel": "~10 meses",
  "allergies": "Pollo",
  "notes": null,
  "status": "ACTIVE",
  "archivedAt": null,
  "archivedReason": null,
  "createdVia": "CHATBOT",
  "version": 3,
  "createdAt": "2026-11-23T16:20:11.000Z",
  "updatedAt": "2026-11-23T16:20:11.000Z"
}
```

Every **write** (create, PATCH, archive, restore) returns the **complete pet** plus `"warnings": string[]` (empty when none), so you replace your copy without refetching. `GET` returns an array of pets (no `warnings`).

`GET /chatbot-api/customers/:customerId/pets?status=ACTIVE|ARCHIVED|ALL` (scope `pets:read`) → `200 [Pet, …]`. Default `ACTIVE`, sorted by name (accents and case ignored; ties by creation, then id). `ARCHIVED` is sorted by `archivedAt` descending, `ALL` newest first. An unknown customer → `404 CUSTOMER_NOT_FOUND`; a `status` other than the three values → `400`.

`customer.pets` in `GET /chatbot-api/customers/by-phone?phoneCountryCode=52&phone=5512349901` is the same array, **ACTIVE pets only**, same order:

```json
{ "found": true,
  "customer": { "customerId": "5c1e9a02-…", "firstName": "Ana", "lastName": null,
                "phoneCountryCode": "52", "phone": "5512349901",
                "preferredPaymentMethod": null, "address": null,
                "pets": [ { "id": "8d0e0f6e-…", "name": "Bruno", "ageLabel": "~10 meses", "…": "…" } ] } }
```

Read archived pets through `GET …/pets?status=ARCHIVED|ALL`. No feed event is written when staff edit a pet: read the pets on each turn.

## 3. Age (D5)

Age is never stored; `ageMonths` and `ageLabel` are computed at read time from `birthDate` in the business timezone (`PROMOTIONS_BUSINESS_TIMEZONE`, default `America/Mexico_City`). Both are non-null **whenever `birthDate` is set, in every response that carries a pet, write responses included**, and `null` otherwise.

| `birthDatePrecision` | Label examples | Meaning |
| --- | --- | --- |
| `EXACT` | `«10 meses»`, `«3 años»`, `«1 año 4 meses»` | the stored day is the real birth date |
| `MONTH` or `YEAR` | `«~10 meses»`, `«~3 años»` | approximate; the label has the prefix `«~»` (never the word «aprox») |
| any | `«menos de 1 mes»` | under one month (no prefix) |

`ageMonths` is the whole number of months between `birthDate` and today.

Send **either** an exact date **or** an approximate age:

| You send | Stored |
| --- | --- |
| `"birthDate": "2024-03-15", "birthDatePrecision": "EXACT"` | as sent |
| `"birthDate": "2024-03-20", "birthDatePrecision": "MONTH"` | day forced to `01` → `2024-03-01` |
| `"birthDate": "2024-03-20", "birthDatePrecision": "YEAR"` | forced to January 1 → `2024-01-01` |
| `"approxAge": { "months": 10 }` | first day of (today − 10 months), `MONTH` |
| `"approxAge": { "years": 3 }` | January 1 of (current year − 3), `YEAR` |
| `"approxAge": { "years": 1, "months": 4 }` | first day of (today − 16 months), `MONTH` |

- `approxAge`: whole numbers, `years` 0–50 and/or `months` 0–600, at least one of them.
- `approxAge` together with `birthDate` or `birthDatePrecision` → `400` (field `approxAge`).
- `birthDate` is `YYYY-MM-DD`, a real calendar date, **not in the future** (after the MONTH/YEAR normalization above); it needs `birthDatePrecision` and the precision needs the date (`400` otherwise).

## 4. Routes (`/chatbot-api/customers/:customerId/pets`)

`customerId` comes from `by-phone` (`customer.customerId`), so writes are keyed by customer and avoid the phone ambiguity (customers are not unique per phone). Every id in the path must be a UUID (`400` otherwise). An unknown or other-sucursal customer → `404 CUSTOMER_NOT_FOUND`; an unknown pet, or a pet of another customer or sucursal → `404 PET_NOT_FOUND`.

### 4.1 `POST /chatbot-api/customers/:customerId/pets` — create (scope `pets:write`, `X-Idempotency-Key` required)

```http
POST /chatbot-api/customers/5c1e9a02-77d4-4b8a-a1f3-0e2d4c6b8a90/pets
X-Idempotency-Key: pet-migration:5c1e9a02-77d4-4b8a-a1f3-0e2d4c6b8a90:1
Content-Type: application/json

{ "name": "Bruno", "species": "DOG", "breed": "Chihuahua", "size": "SMALL",
  "approxAge": { "months": 10 }, "allergies": "Pollo" }
```

→ `201` with the complete pet and `warnings` (shape of §2 plus `"warnings": []`). `createdVia` is `CHATBOT`.

- `name` and `species` are required; everything else is optional, and `null` is the same as absent on create. Unknown members are rejected (`400`).
- **Idempotent.** The key is per sucursal, 1–200 characters after trimming. The receipt lives in `chatbot_bot_receipts` (kind `CUSTOMER_PET_CREATE`) and is written in the same transaction as the pet, so a rejected create (any `4xx`) leaves **no** receipt and the same key can be used again.

| Situation | Answer |
| --- | --- |
| first request | `201` with the pet |
| same key + same body | **`200`** with **the first response, byte for byte**: same `id`, `version`, `warnings`, `createdAt` and the **age fields as computed at the first create** (`ageMonths` / `ageLabel` are not recomputed). The replay does not look at the pet again: if it was edited, archived or deleted since, you still get the first answer. Reread with `GET` when you need the current state |
| same key + different body | `409 IDEMPOTENCY_KEY_CONFLICT` |
| same key while the first request is still running | `409 IDEMPOTENCY_KEY_IN_FLIGHT` (retry shortly) |
| key missing, blank or over 200 characters | `400 INVALID_IDEMPOTENCY_KEY` |

The body comparison ignores spelling of absence (`null` and a missing member hash the same) and includes the `customerId` of the path, so the same key for another customer is a conflict. Codes are the same as the backorders', so one handler serves both.

Other errors: `400` field validation (§9), `404 CUSTOMER_NOT_FOUND`, `422 PET_LIMIT_REACHED`.

### 4.2 `PATCH /chatbot-api/customers/:customerId/pets/:petId` — edit (scope `pets:write`)

`version` (the pet's current version, integer ≥ 1) is required in the body; the other members are the create members, all optional.

```json
{ "version": 3, "allergies": null, "size": "MEDIUM" }
```

→ `200` complete pet + `warnings`. **Absent vs `null`:**

- **Absent = unchanged.** Send only what changes. Per the agreement C1 the bot never sends fields it does not change.
- **`null` clears** a nullable field: `breed`, `size`, `allergies`, `notes`, `speciesOther`, and the birth date (`"birthDate": null` clears the date and its precision; sending only `"birthDatePrecision": null` changes nothing). Blank text also clears.
- **`null` on `name` or `species` → `400`** (they cannot be cleared).
- Changing `species` away from `OTHER` clears `speciesOther` by itself; moving to `OTHER` needs a `speciesOther` (`400` otherwise).
- `approxAge` and `birthDate` follow §3.
- `warnings` carries `PET_NAME_DUPLICATE` only when the name changed.

Checks run in this order: shape of the body (`400`: types, lengths, enums, missing `version`), pet exists (`404`), `version` (`409 PET_VERSION_CONFLICT`), pet is ACTIVE (`422 PET_ARCHIVED`: restore first), then the cross-field rules (`400`: `speciesOther`, birth date and precision, `approxAge`).

**PATCH is not keyed. Retry advice after a timeout** (the first attempt may have applied): resend with the same `version`; if the pet had changed you get `409 PET_VERSION_CONFLICT` with `currentVersion` at the body root. **Reread the pet (`GET …/pets?status=ALL`, find it by `id`), and treat the edit as done when its values already match what you wanted**; otherwise retry with the new `version`. The same applies to archive and restore.

### 4.3 `POST …/:petId/archive` — «ya no está» (scope `pets:write`)

```json
{ "version": 3, "reason": "Se fue con otra familia" }
```

`reason` is optional (≤ 280, blank → `null`). → `200` complete pet with `status: "ARCHIVED"`, `archivedAt`, `archivedReason`. Archiving an archived pet → `422 PET_ARCHIVED`. The pet leaves the ACTIVE list and `customer.pets`; its sale lines and history stay intact.

### 4.4 `POST …/:petId/restore` — undo an archive (scope `pets:write`)

```json
{ "version": 4 }
```

→ `200` complete pet with `status: "ACTIVE"` (`archivedAt` and `archivedReason` back to `null`) + `warnings` (may carry `PET_NAME_DUPLICATE`). Restoring an active pet → `422 PET_NOT_ARCHIVED`; past 20 active → `422 PET_LIMIT_REACHED`.

### 4.5 `DELETE …/:petId?version=N` — real erasure, «olvida mis datos» (scope `pets:delete`)

```http
DELETE /chatbot-api/customers/5c1e9a02-…/pets/8d0e0f6e-…?version=4
```

- `version` is a **query parameter, never a body**; missing or not an integer ≥ 1 → `400`.
- → `204` with no body. Stale `version` → `409 PET_VERSION_CONFLICT {currentVersion}`.
- Works on an ACTIVE or an ARCHIVED pet. In the same transaction the pet row is deleted and its sale lines get `petId = NULL` **and** `petNameSnapshot` / `petSpeciesSnapshot` cleared: nothing identifying the pet remains. The lines, products and amounts stay, and their `pet` reads `null` (§6).
- **A `404 PET_NOT_FOUND` on a retry after a timeout means it is done** (the first attempt had already deleted it).
- Use it only for an **explicit** «olvida mis datos». «Bruno ya no está» / «olvida a Bruno» is an archive (§4.3).

Deleting a customer (POS flow) deletes its pets too; their sale lines keep the snapshot and read `pet.status: null`.

## 5. Checkout: `sale.items[i].petId` (scope as `POST /chatbot-api/checkouts`)

`POST /chatbot-api/checkouts` accepts an **additive, optional** `petId` (UUID) on each `sale.items[i]`:

```json
{ "sale": { "items": [
    { "productId": "uuid", "variantId": null, "quantity": 2, "unitPriceCents": 45900, "petId": "8d0e0f6e-5b87-4c2c-8d3a-1f6f0c7a9b11" },
    { "productId": "uuid", "variantId": null, "quantity": 1, "unitPriceCents": 12000 }
  ], "…": "…" }, "…": "…" }
```

- `petId` is the pet this line is for: an **ACTIVE pet of the checkout's customer**. `null` is the same as omitted.
- **Idempotency hash:** `petId` joins the request hash **only when present** (like `backorderId`), so a request without it hashes byte for byte as before and stored receipts still replay. A retry under the same `X-Idempotency-Key` that **adds, removes or changes** a `petId` therefore has a different hash and gets the checkout's existing idempotency-conflict answer (`409 IDEMPOTENCY_KEY_CONFLICT`). A byte-identical retry replays as always.
- **One line per product/variant.** The sale merges lines of the same product (and variant) into one line, which has one pet. So in one checkout the lines of the same product/variant must **agree**: two lines for the same product with **two different pets**, or one **with a pet and one without**, answer `400 INVALID_CHECKOUT_REQUEST` and nothing is created. To buy the same product for two pets, the bot cannot do it in one checkout (a single line cannot carry two pets); backorder lines are not merged and are not part of this rule.
- Pet errors (code-only, like every checkout error): `404 PET_NOT_FOUND` (unknown, or another sucursal's), `422 PET_CUSTOMER_MISMATCH` (a pet of another customer), `422 PET_ARCHIVED`. Nothing is created when one of them answers (not even the customer a `createIfAbsent` would have created: a customer created by the same checkout owns no pet, so a `petId` there is `422 PET_CUSTOMER_MISMATCH`), and the key stays retryable. A non-UUID `petId` is `400 INVALID_CHECKOUT_REQUEST`.
- **The checkout response carries no pet.** Read the pet of each line from the order history (§6).
- Confirmed sales keep their pet data as part of the sale record; archiving the pet later does not touch the lines.

## 6. Order history: `pet` per line and `?petId=`

`GET /chatbot-api/customers/by-phone/:phone/orders?phoneCountryCode=52[&petId=<uuid>]` (scope `customers:read`). The answer is the last 5 confirmed orders, newest first, as before; each element of an order's `items` gets an additive `pet` member:

```json
{ "saleId": "uuid", "folio": "…", "confirmedAt": "2026-11-20T18:02:11.000Z",
  "items": [
    { "productId": "uuid", "variantId": null, "productName": "Croquetas Adulto 18 kg", "variantName": null,
      "quantity": 2, "unitPriceCents": 45900,
      "pet": { "id": "8d0e0f6e-…", "name": "Bruno", "species": "DOG", "status": "ACTIVE" } },
    { "productId": "uuid", "variantId": null, "productName": "Shampoo", "variantName": null,
      "quantity": 1, "unitPriceCents": 12000, "pet": null }
  ],
  "…": "…" }
```

| `pet` | When |
| --- | --- |
| `{ id, name, species, status }` | the line was assigned a pet. `id`, `name` and `species` come from the **snapshot copied at assignment** (a later rename does not change them); **`status` is the pet's current status** (`ACTIVE` / `ARCHIVED`) |
| `{ "id": null, "name": "Bruno", "species": "DOG", "status": null }` | the pet row is gone only because its **customer was deleted**: the snapshot stays, `id` and `status` are `null` |
| `null` | no pet on the line, old lines, and lines of a pet that was **really deleted** (§4.5). Never an object of nulls |

- **`?petId=<uuid>`** keeps only the orders with **at least one line for that pet**, and each returned order keeps **all its lines** (the other lines show their own `pet`). A malformed UUID → `400`. A pet that is not one of **this customer's** (unknown, another customer's or another sucursal's) → **`404 PET_NOT_FOUND`**, never an empty list; so does an unknown phone **when `petId` is sent** (without `petId` an unknown phone is still `[]`). A pet with no orders yet → `200 []`.
- **The order of the lines inside an order is not guaranteed** (pre-existing behavior of this route; do not rely on it, match lines by `productId` / `variantId`).

## 7. Migration of the bot's existing pets

The normal create route with its idempotency is enough; there is no separate import.

1. **Dry run first.** Count what you would send and write nothing: for each stored phone call `GET /chatbot-api/customers/by-phone` and keep only the numbers with `found: true` (customers are not created for pets). Optionally compare with `customer.pets` (needs `pets:read`) to see who already has pets.
2. Migrate only numbers that resolve to a Customer. Use `customer.customerId` for the path.
3. **Deterministic key** `pet-migration:<customerId>:1` for the first pet of a customer (`:2`, `:3`… for the next ones, in a stable order), so the script is safely re-runnable: a rerun with the same body replays `200`, with a changed body it is `409 IDEMPOTENCY_KEY_CONFLICT`. Handle `IDEMPOTENCY_KEY_IN_FLIGHT` by retrying.
4. Convert the stored age text to `approxAge` (`{ "years": 3 }`, `{ "months": 10 }`, `{ "years": 1, "months": 4 }`), or send `birthDate` + `birthDatePrecision` when you have a date. **Anything you cannot parse goes into `notes`** (≤ 500 characters) and no age is sent.
5. `createdVia` becomes `CHATBOT` by itself. A customer already at 20 active pets answers `422 PET_LIMIT_REACHED`; log it and continue.
6. Tens of pets, not thousands (agreement C3): a loop with the normal route is fine; the credential's `write` bucket applies (`429` + `Retry-After`).

## 8. What does not change

`GET /chatbot-api/customers/by-phone` without `pets:read`, `PUT customers/by-phone`, the checkout response and every request that does not send `petId`, the feed and the other routes are unchanged. Old orders have `pet: null` on every line.

## 9. Errors

| HTTP | `error` (+ detail) | When |
| --- | --- | --- |
| 400 | per-field validation (`message` array of `{ property, children, constraints }`) | lengths, enums, `speciesOther` rules, future or invalid `birthDate`, precision without date, `approxAge` with `birthDate`, `null` on `name`/`species`, missing/invalid `version`, unknown members, non-UUID ids, bad `?status=` |
| 400 | `INVALID_IDEMPOTENCY_KEY` | create without a valid `X-Idempotency-Key` (§4.1) |
| 400 | `INVALID_CHECKOUT_REQUEST` | checkout lines of the same product/variant disagree on the pet, or a non-UUID `petId` (§5) |
| 404 | `CUSTOMER_NOT_FOUND` | unknown customer in the path |
| 404 | `PET_NOT_FOUND` | unknown pet, or a pet of another customer/sucursal; a deleted pet; `?petId=` on orders (§6); `petId` in checkout (§5) |
| 409 | `PET_VERSION_CONFLICT {currentVersion}` | stale `version` on PATCH, archive, restore or DELETE |
| 409 | `IDEMPOTENCY_KEY_CONFLICT` | pet create (or checkout) key reused with another body |
| 409 | `IDEMPOTENCY_KEY_IN_FLIGHT` | pet create key held by a request still running |
| 422 | `PET_ARCHIVED` | PATCH or archive of an archived pet; checkout with an archived pet |
| 422 | `PET_NOT_ARCHIVED` | restore of an active pet |
| 422 | `PET_LIMIT_REACHED` | the 21st active pet (create or restore) |
| 422 | `PET_CUSTOMER_MISMATCH` | checkout `petId` of another customer |
| 403 | — | missing scope |
| 500 | `CUSTOMER_PET_REQUEST_FAILED` | unknown failure |

`PET_NAME_DUPLICATE` is a **warning** (`warnings` of a successful write), never an error.

## Differences from the proposal

Where the code and `docs/proposals/customer-pets-contract.md` differ, this document follows the code:

- The proposal left the POS sale routes and the POS history route open; they exist now (frontend handoff, not for the bot).
- `ageLabel` for «under one month» is `«menos de 1 mes»` **without** the `«~»` prefix even for `MONTH`/`YEAR` precision (the label already says it is approximate).
- A checkout with two lines of the same product and **different** pets (or pet + no pet) is `400 INVALID_CHECKOUT_REQUEST`; the proposal did not cover it.
- `?petId=` on order history also answers `404 PET_NOT_FOUND` for an unknown phone (the proposal only said «foreign or unknown petId»).

## Deploy checklist

1. Apply, in this order (both additive, each in one short transaction): `20261123000000_customer_pets` (five enums, table `customer_pets`, three nullable columns and an index on `sale_items`; run at low traffic: the index build blocks writes on `sale_items` briefly) and `20261123010000_customer_pet_bot_receipt_kind` (widens the `chatbot_bot_receipts_kind_chk` CHECK with `CUSTOMER_PET_CREATE`; no data change). **Do not deploy the bot's pet create before the second one**: an older database rejects the receipt and answers `500`.
2. Add `pets:read`, `pets:write` and `pets:delete` to the chatbot's `svc_` credential (scopes are exact strings, no wildcards). Without `pets:read` the bot does not see `customer.pets`.
3. Your parsers must ignore unknown members: order lines gain `pet`, `by-phone` may gain `customer.pets`. Deploy the backend **after** the bot tolerates them.
4. Existing routes, scopes, feed events and checkout requests without `petId` are unchanged.
