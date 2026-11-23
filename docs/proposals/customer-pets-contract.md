# Customer pets («varias mascotas por cliente») — contract proposal v0

Status: **v1 APPROVED by the chatbot and the frontend 2026-11-23; owner answers Q1/Q2/D8 given directly in the backend session (§10).** Implemented on `feat/customer-pets` (final routes and the points the contract left open: §12). v1 changes: §11. The owner decided the feature on 2026-11-23, relayed by the chatbot agent. Facts below cite the current backend (`main` b6c9fbd6).

## 0. Owner decisions this contract implements

| # | Decision (as relayed) | Where |
|---|---|---|
| D1 | Pets live in the BACKEND (Customer → pets), visible and editable from the POS | §1, §5 |
| D2 | With 2+ pets and an order without a clear recipient, the bot asks with buttons («¿para Max (labrador, adulto) o para Bruno (chihuahua de 10 meses)?») | §2 (bot-side behavior; the backend provides species, breed and age) |
| D3 | History per pet («¿lo mismo de siempre para Max?») | §4 |
| D4 | Allergies and notes, warning only (the catalog has no ingredients) | §1 (stored text; the backend does not match it against products) |
| D5 | Age that advances by itself (approximate birth date, never frozen text) | §1.2 |
| D6 | Forget a pet («Bruno ya no está» / «olvida a Bruno») | §6, §10 Q1 |
| D7 | (2026-11-23, confirmed with the frontend) Printed ticket: no pet in v1; only «Para: <nombre>» in the sale detail and history. Every line still carries the fixed `pet` copy for a future ticket | §4 |
| D8 | (2026-11-23, answered by the owner in the backend session after the chatbot and frontend relays conflicted) Several active pets with the same name are allowed; **the backend warns** with `warnings: ["PET_NAME_DUPLICATE"]` | §1.1 |
| D9 | Q1 (b): «ya no está» / «olvida a Bruno» → archive (restorable); explicit «olvida mis datos» → real deletion | §6 |
| D10 | Q2: at most 20 ACTIVE pets per customer | §1.1 |

## 1. Model

New tenant-scoped table `customer_pets` (tenant = branch, like `Customer`; registered in `tenant-scoped-models.constant.ts`):

| Field | Type | Notes |
|---|---|---|
| `id` | UUID | |
| `tenantId` | UUID | always the customer's tenant |
| `customerId` | UUID | FK `Customer`, `onDelete: Cascade` (like `CustomerAddress`) |
| `name` | text 1–60 | trimmed; required |
| `nameKey` | text | `name` without accents, lowercased, collapsed spaces (same normalization as `inbox-search.ts:28`); used for POS search and the duplicate warning |
| `species` | enum `DOG`, `CAT`, `OTHER` | required |
| `speciesOther` | text ≤ 40 | required when `species = OTHER`, otherwise must be null |
| `breed` | text ≤ 80, nullable | free text |
| `size` | enum `SMALL`, `MEDIUM`, `LARGE`, `GIANT`, nullable | |
| `birthDate` | date, nullable | not in the future (tenant timezone) |
| `birthDatePrecision` | enum `EXACT`, `MONTH`, `YEAR`, nullable | required when `birthDate` is set, otherwise null |
| `allergies` | text ≤ 500, nullable | warning only (D4) |
| `notes` | text ≤ 500, nullable | |
| `status` | enum `ACTIVE`, `ARCHIVED` | default `ACTIVE` |
| `archivedAt` / `archivedReason` (≤ 280) | nullable | set by archive, cleared by restore |
| `createdVia` | enum `POS`, `CHATBOT` | |
| `version` | int | starts at 1; +1 on every write (edit, archive, restore) |
| `createdAt` / `updatedAt` | timestamptz | |

Indexes: `(tenantId, customerId, status)`, `(tenantId, nameKey)` for POS search (no uniqueness on names, D8).

### 1.1 Limits and names

- **At most 20 ACTIVE pets per customer.** Create or restore past the limit → `422 PET_LIMIT_REACHED`. Archived pets do not count; `GET ...?status=ALL` is capped at 100 rows (newest first) so the list stays unpaginated.
- **Duplicate names are allowed** among active pets (D8). Create, PATCH (when `name` changes) and restore return `warnings: ["PET_NAME_DUPLICATE"]` when another ACTIVE pet of the same customer has the same `nameKey`; the write still succeeds. The bot disambiguates with species, breed and age and always works with `id`.
- Create and restore lock the customer row (`FOR UPDATE`, same lock checkout and customer delete take) so two concurrent creates cannot pass the limit.

### 1.2 Age (D5)

Age is never stored. Every pet response carries derived, read-time fields computed in the tenant timezone:

| Field | Meaning |
|---|---|
| `ageMonths` | whole months between `birthDate` and today, or null |
| `ageLabel` | Spanish label for buttons and the POS: `«10 meses»`, `«3 años»`, `«1 año 4 meses»`; prefixed `«~»` (never the word «aprox») when precision is `MONTH` or `YEAR`, e.g. `«~10 meses»`; under one month `«menos de 1 mes»` |

Both fields are present (non-null) whenever `birthDate` is set, in every response that carries a pet, including the write responses.

Writers send either an explicit date or an approximate age; the server converts:

| Input | Stored |
|---|---|
| `birthDate: "2024-03-15"`, `birthDatePrecision: "EXACT"` | as sent |
| `birthDate: "2024-03-01"`, `birthDatePrecision: "MONTH"` | day forced to 01 |
| `approxAge: { "months": 10 }` | first day of (today − 10 months), `MONTH` |
| `approxAge: { "years": 3 }` | January 1 of (current year − 3), `YEAR` (frontend rule) |
| `approxAge: { "years": 1, "months": 4 }` | first day of (today − 16 months), `MONTH` |

`approxAge` and `birthDate` are mutually exclusive → `400` with a field error.

## 2. Response shape (shared by POS and bot)

```json
{
  "id": "uuid",
  "customerId": "uuid",
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
  "createdAt": "…",
  "updatedAt": "…"
}
```

Every write (create, PATCH, archive, restore) returns the **complete pet** (new `version`, derived age fields) plus `warnings: string[]` (empty when none), so clients replace their cached copy without refetching.


## 3. Write semantics (POS and bot)

- **Create**: `name` and `species` required; the rest optional.
- **PATCH is partial**: an absent field is unchanged. **`null` clears a nullable field** (`breed`, `size`, `birthDate`+precision, `allergies`, `notes`, `speciesOther`); `null` on `name` or `species` → `400`. The POS needs to clear allergies, so `null` must mean "clear". The bot can keep its «null no borra» behavior by simply not sending a field (open point for the chatbot, §10 C1).
- **Optimistic concurrency**: PATCH, archive and restore require `version` (the pet's current version). Mismatch → `409 PET_VERSION_CONFLICT` with `currentVersion` at the body root (same shape as backorder `VERSION_CONFLICT`).
- PATCH on an `ARCHIVED` pet → `422 PET_ARCHIVED` (restore first).
- **Archive** `{ version, reason? }`: `ACTIVE → ARCHIVED`. Archiving an archived pet → `422 PET_ARCHIVED`.
- **Restore** `{ version }`: `ARCHIVED → ACTIVE`, checks the 20 limit. Restoring an active pet → `422 PET_NOT_ARCHIVED`.

## 4. Sale line → pet (D3)

### 4.1 Storage

`SaleItem` gets additive nullable columns:

| Column | Notes |
|---|---|
| `petId` | FK `customer_pets`, `onDelete: SetNull` |
| `petNameSnapshot` / `petSpeciesSnapshot` | copied when the line is assigned; never updated by later pet edits |

Sale and order-history responses expose `pet: { id, name, species, status } | null` per line: `id`, `name` and `species` come from the snapshot; **`status` is the pet's current status** (`ACTIVE`, `ARCHIVED`), because a snapshot status would always read `ACTIVE`. `pet: null` (never an object of nulls) for old lines, lines without a pet, and lines whose pet was erased (§6). When the pet row disappeared only because its customer was deleted, the line keeps the snapshot and returns `status: null`.

`pet` per line appears in every sale response the POS uses (`GET /sales/:id`, the sales list/detail and draft responses) and in the bot order history.

### 4.2 Rules (POS drafts and bot checkout)

- The pet must belong to the sale's customer → otherwise `422 PET_CUSTOMER_MISMATCH`; unknown id → `404 PET_NOT_FOUND`.
- The pet must be `ACTIVE` when assigned → `422 PET_ARCHIVED`. Archiving a pet later does not touch existing lines.
- Sale without a customer: any `petId` → `422 PET_CUSTOMER_MISMATCH`.
- **POS drafts** (`create|update Sale`): `petId` optional per line, `null` clears it. When the draft's customer changes or is removed, every line `petId` is cleared and the response of that draft update carries `petsCleared: true` (`false` otherwise).
- **Bot checkout** `POST /chatbot-api/checkouts`: `sale.items[i].petId?: uuid | null` (additive; joins the request hash only when present, like `backorderId`, so stored receipts still replay). A retry that adds, removes or changes a `petId` under the same `X-Idempotency-Key` has a different hash and gets the checkout's existing idempotency-conflict answer.
- Confirmed sales keep their pet data as part of the sale record. The printed ticket does not show pets in v1 (D7); the POS shows «Para: <nombre>» from `pet.name` in the sale detail and history.

## 5. POS API (staff JWT, CASL `Customer`)

Same pattern as `/customers/:id/addresses`; reuses `read:Customer` and `update:Customer` (no new subject, so the frontend permission list does not change).

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/customers/:customerId/pets?status=ACTIVE\|ARCHIVED\|ALL` | read Customer | default `ACTIVE`; ACTIVE sorted by name, ARCHIVED by `archivedAt desc` |
| POST | `/customers/:customerId/pets` | update Customer | `createdVia = POS`; `201` |
| PATCH | `/customers/:customerId/pets/:petId` | update Customer | §3 |
| POST | `/customers/:customerId/pets/:petId/archive` | update Customer | `{ version, reason? }` |
| POST | `/customers/:customerId/pets/:petId/restore` | update Customer | `{ version }` |
| DELETE | `/customers/:customerId/pets/:petId?version=N` | delete Customer | real erasure, §6; `204` |

Additive changes elsewhere:
- `GET /customers/:id` adds `activePetsCount`.
- Customer search (`GET /customers?search=`) also matches ACTIVE pet names (by `nameKey`); every list item carries `matchedPetName` (null when the match came from the customer's own fields or there is no search).
- The customer sales history the POS card uses accepts `?petId=`; a `petId` of another customer (or unknown) → `404 PET_NOT_FOUND`, never an empty list. The exact route is confirmed to the frontend when the implementation plan is written.
- Validation errors (`400`) use the same per-field format as the existing customer create/update endpoints.


## 6. Forgetting (D6)

- **«Bruno ya no está» / «olvida a Bruno» → archive** with an optional reason. The pet leaves the active list, the bot stops offering it, its sale lines and history stay intact, and staff can restore it.
- **«Olvida mis datos»** (explicit request only, D9) → real erasure: `DELETE` the pet row (ACTIVE or ARCHIVED; the current version is required as the **query parameter `?version=N`**, never a body, because some proxies and clients drop DELETE bodies; missing or non-integer → `400`; stale → `409 PET_VERSION_CONFLICT`), which sets `SaleItem.petId = NULL` and **also clears** `petNameSnapshot`/`petSpeciesSnapshot` on its lines in the same transaction, so nothing identifying the pet remains; the sale lines, products and amounts stay and their `pet` reads `null`. `204` on success.
  - POS: `DELETE /customers/:customerId/pets/:petId?version=N`, permission `delete:Customer`.
  - Bot: `DELETE /chatbot-api/customers/:customerId/pets/:petId?version=N`, scope `pets:delete`. Deleting an already deleted pet → `404 PET_NOT_FOUND` (the bot treats it as done after a timeout).
- Deleting a customer (existing flow) cascades to its pets; their sale lines get `petId = NULL` and keep the snapshot, like the sale keeps its line names today.

## 7. Bot API (`/chatbot-api`, service credential)

New scopes: **`pets:read`**, **`pets:write`**, **`pets:delete`** (constants file like `BACKORDER_SCOPES`, audit allowlist, handoff doc, production credential checklist and dev guide updated).

| Method | Path | Scope | Notes |
|---|---|---|---|
| GET | `customers/by-phone` (existing) | `customers:read` | **additive** `customer.pets: Pet[]` (ACTIVE only) when the credential also has `pets:read`; field omitted otherwise |
| GET | `customers/:customerId/pets?status=` | `pets:read` | same as POS |
| POST | `customers/:customerId/pets` | `pets:write` | `X-Idempotency-Key` required; `createdVia = CHATBOT` |
| PATCH | `customers/:customerId/pets/:petId` | `pets:write` | §3 (idempotent by `version`) |
| POST | `customers/:customerId/pets/:petId/archive` | `pets:write` | `{ version, reason? }` |
| POST | `customers/:customerId/pets/:petId/restore` | `pets:write` | `{ version }` |
| DELETE | `customers/:customerId/pets/:petId?version=N` | `pets:delete` | real erasure, §6; `204` |
| GET | `customers/by-phone/:phone/orders` (existing) | `customers:read` | **additive** `pet` per line (§4.1) and optional `?petId=` filter |

Writes are keyed by `customerId` (taken from `by-phone`), so they avoid the phone-matching ambiguity (customers are not unique per phone).

**Idempotent create** stores its receipt in the existing table `chatbot_bot_receipts` (kind `CUSTOMER_PET_CREATE`) but answers with **the same codes as backorders**, so the bot keeps one handler: same key + same body → replays the first response with `200` (first create `201`); same key + different body → `409 IDEMPOTENCY_KEY_CONFLICT`; concurrent → `409 IDEMPOTENCY_KEY_IN_FLIGHT`; missing or invalid key → `400 INVALID_IDEMPOTENCY_KEY`.

**PATCH, archive and restore are not keyed**: a retry after a timeout whose first attempt applied gets `409 PET_VERSION_CONFLICT`; the bot rereads the pet and accepts it when the values already match (chatbot behavior, no backend idempotency needed).

**No feed event** when staff edit a pet: the bot reads pets on each turn (chatbot proposal accepted; the POS also refetches).

## 8. Errors

Code-only envelope (`{ statusCode, error: CODE, message: CODE, ...details }`):

| HTTP | Code | When |
|---|---|---|
| 400 | validation (per-field details) | lengths, enums, future `birthDate`, precision without date, `approxAge` + `birthDate`, `speciesOther` rules |
| 404 | `PET_NOT_FOUND` | unknown pet, or a pet of another customer/tenant in pet routes |
| 404 | `CUSTOMER_NOT_FOUND` | unknown customer in the path |
| 409 | `PET_VERSION_CONFLICT` | stale `version`; body has `currentVersion` |
| 422 | `PET_ARCHIVED` | edit/archive/assign an archived pet |
| 422 | `PET_NOT_ARCHIVED` | restore an active pet |
| 422 | `PET_LIMIT_REACHED` | 21st active pet |
| 422 | `PET_CUSTOMER_MISMATCH` | sale line pet of another customer, or sale without customer |
| 409 | `IDEMPOTENCY_KEY_CONFLICT` / `IDEMPOTENCY_KEY_IN_FLIGHT` | bot create retries (§7) |

## 9. Migration of the bot's existing pets

The normal bot create endpoint with idempotency is enough; no separate import:
- The bot migrates only numbers that resolve to a Customer (`GET customers/by-phone`, `found: true`).
- Deterministic key, e.g. `pet-migration:<customerId>:1`, so the script is safely re-runnable.
- The bot converts its stored age text to `approxAge` (or `birthDate` when it has one); anything it cannot parse goes to `notes`.
- `createdVia = CHATBOT`.

If the volume is large (thousands), tell me and I add a rate note or a batch endpoint.

## 10. Resolved points (2026-11-23)

### Owner (answered directly in the backend session)

- **Q1** → (b): archive for «ya no está» / «olvida a Bruno»; real deletion only for an explicit «olvida mis datos» (§6, D9). Also relayed identically by the chatbot and the frontend.
- **Q2** → 20 ACTIVE pets per customer (D10).
- **Duplicate names** → allowed, with the backend warning `PET_NAME_DUPLICATE` (D8). The chatbot relayed «no code, the POS warns» and the frontend relayed «warning PET_NAME_DUPLICATE»; the owner settled it in the backend session.

### Chatbot

- **C1** OK: the bot never sends fields it does not change; `null` only when the customer asks to remove something.
- **C2** OK: `customer.pets` (ACTIVE) in `by-phone`; archived through `GET .../pets?status=ARCHIVED|ALL`.
- **C3** Tens of pets, not thousands; normal create with deterministic key and a dry-run count first.
- Idempotency code: `IDEMPOTENCY_KEY_CONFLICT` (same as backorders, §7). `ageLabel` uses `~`, never «aprox». A checkout retry that changes `petId` presence is an idempotency conflict (§4.2). PATCH retries handled by reread (§7).

### Frontend

- **F1** OK, with `ageMonths`/`ageLabel` present in write responses too (§1.2).
- **F2** OK; erased pet → `pet: null` (§4.1).
- **F3** OK.
- Writes return the complete pet with the new `version`; `pet` per line in every POS sale response; `petsCleared` on the draft update; `?petId=` foreign → 404; `matchedPetName` on `GET /customers?search=` items; 400 in the customers' per-field format (§2, §4, §5).

## 11. Changes v0 → v1

- D7–D10 added; `warnings: ["PET_NAME_DUPLICATE"]` on writes (D8).
- Real deletion (§6): `DELETE ...?version=N` in POS (`delete:Customer`, row added to §5) and bot (scope `pets:delete`, row added to §7), scrubbing the line snapshots.
- Bot create conflict code aligned to `IDEMPOTENCY_KEY_CONFLICT`.
- Write responses return the complete pet; derived age always present with `birthDate`.
- `pet` per line in all POS sale responses; erased pet → `pet: null`; `petsCleared` on draft update; `?petId=` foreign → 404; `matchedPetName` in the customer list; 400 format as customers.

## 12. Implementation notes (final routes)

Built on `feat/customer-pets`. The two handoffs are the reference for the shipped behavior: `docs/chatbot-handoff/customer-pets-bot-contract.md` (bot) and `docs/frontend-handoff/27-customer-pets.md` (POS). Where this proposal and the code differ, the handoffs follow the code. Routes and details the proposal left open:

- **POS sale line routes (§4.2).** `POST /sales/drafts/:id/items` accepts an optional `petId` (absent keeps the line's pet, a uuid assigns it, `null` clears it), and the new `PUT /sales/drafts/:id/items/:itemId/pet` takes `{ petId: uuid | null }` (required member). Both need `update:Sale` and answer with the draft.
- **`petsCleared` (§4.2).** `PUT /sales/drafts/:id/customer` returns `petsCleared: true` only when some line really lost a pet (`false` otherwise, also when the same customer is assigned again). **`DELETE /sales/drafts/:id/customer` stays `204` with no body** and clears the line pets server-side.
- **POS history route (§5).** `GET /sales?customerId=<uuid>&petId=<uuid>`: `petId` needs exactly one `customerId` (`400 PET_FILTER_REQUIRES_CUSTOMER`, code-only envelope); a pet that is not that customer's → `404 PET_NOT_FOUND`. `data`, `pagination.total`/`totalPages` and `filterSummary` narrow to the pet; `counts` and `summary` (the KPIs) stay customer-wide.
- **Customer search (§5).** `GET /customers?search=` **did not exist before**; it was added here. Every word (at most 6) must match `firstName`, `lastName`, `email`, `phone` or `businessName`, case-insensitive and accent-sensitive; a customer also matches when an ACTIVE pet's name contains the whole term (accent-folded, via `nameKey`). `matchedPetName` is the pet's name only when the customer matched through a pet alone, otherwise `null`.
- **`INVALID_CHECKOUT_REQUEST` (§4.2).** The sale merges lines of one product/variant into one line with one pet, so a checkout with lines of the same product/variant that disagree on the pet (two different pets, or a pet and none) answers `400 INVALID_CHECKOUT_REQUEST` and creates nothing. The checkout response carries no `pet`.
- **Bot order history (§4.1, §7).** `?petId=` keeps **all** the lines of the matching orders; a snapshot whose pet row is gone is `{ id: null, name, species, status: null }`; `?petId=` with an unknown phone is `404 PET_NOT_FOUND` too. The order of the lines inside an order is not guaranteed (pre-existing).
- **`DELETE` of a customer (§6)** is unchanged (`204`); its pets are removed with it.
- **Receipt kind (§7).** The `chatbot_bot_receipts_kind_chk` CHECK blocked the new kind, so migration `20261123010000_customer_pet_bot_receipt_kind` widens it (alongside `20261123000000_customer_pets`).
- **Age label.** «menos de 1 mes» carries no `«~»` prefix even for `MONTH`/`YEAR` precision.
