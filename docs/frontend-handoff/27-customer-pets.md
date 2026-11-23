# POS — customer pets («varias mascotas por cliente»): pet CRUD, customer search, pet on sale lines, history per pet

**Status:** implemented and merged into local `main` (1e22fb90, 2026-11-23; push and dev deploy pending). Task: `odd/tasks/customer-pets.md` (T1 S1–S5/S9 pet core and POS routes, T3 S7/S8 sale lines and history). Contract: `docs/proposals/customer-pets-contract.md` v1 (approved by the frontend 2026-11-23); the bot side is `docs/chatbot-handoff/customer-pets-bot-contract.md`. Migrations: `20261123000000_customer_pets` and `20261123010000_customer_pet_bot_receipt_kind` (the second one is only for the bot).

Shapes come from the code and its specs (real PostgreSQL): `src/customer-pets/presentation/customer-pets.controller.ts`, `src/customer-pets/presentation/dto/customer-pet.dto.ts`, `src/customers/customers.controller.ts` + `customers.service.ts`, `src/sales/sales.controller.ts`, `src/sales/sales-query.controller.ts`, `src/sales/dto/{add-item,set-item-pet,list-sales-query}.dto.ts`, `src/customer-pets/customer-pets.integration.spec.ts`, `src/sales/sale-line-pets.integration.spec.ts`. Nothing was sent to the dev API.

## What it is

A customer can have several pets (a dog, a cat, other). Staff see and edit them from the customer card, pick a pet on a sale line («Para: Bruno»), search customers by pet name and see the history of one pet. Pets are never deleted by the normal flow: «ya no está» is an **archive** (restorable); only an explicit erasure request uses the real `DELETE`.

## 1. Permissions

No new CASL subject: pets reuse `Customer`, so the permission list does not change.

| Route | Needs |
| --- | --- |
| `GET /customers/:customerId/pets` | `read:Customer` |
| `POST /customers/:customerId/pets` | `update:Customer` |
| `PATCH /customers/:customerId/pets/:petId` | `update:Customer` |
| `POST /customers/:customerId/pets/:petId/archive` | `update:Customer` |
| `POST /customers/:customerId/pets/:petId/restore` | `update:Customer` |
| `DELETE /customers/:customerId/pets/:petId?version=N` | **`delete:Customer`** |
| `GET /customers`, `GET /customers/:id` (search, `matchedPetName`, `activePetsCount`) | `read:Customer` |
| `POST /sales/drafts/:id/items` (with `petId`), `PUT /sales/drafts/:id/items/:itemId/pet`, `PUT /sales/drafts/:id/customer`, `DELETE /sales/drafts/:id/customer` | `update:Sale` (and the usual draft ownership rules) |
| `GET /sales?customerId=&petId=`, `GET /sales/:id` | `read:Sale` |

Hide «Eliminar datos de la mascota» without `delete:Customer`, and the add/edit/archive/restore buttons without `update:Customer`. Every route runs `JWT → tenant context → permissions`; the sucursal is the token's (never send a tenant). A pet of another sucursal is `404`, like an unknown id.

## 2. The pet and the write response

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
  "createdVia": "POS",
  "version": 3,
  "createdAt": "2026-11-23T16:20:11.000Z",
  "updatedAt": "2026-11-23T16:20:11.000Z"
}
```

- Enums: `species` `DOG | CAT | OTHER`; `size` `SMALL | MEDIUM | LARGE | GIANT` or `null`; `birthDatePrecision` `EXACT | MONTH | YEAR` or `null`; `status` `ACTIVE | ARCHIVED`; `createdVia` `POS | CHATBOT`.
- Limits: `name` 1–60 (trimmed, required), `speciesOther` ≤ 40 (**required when `species` is `OTHER`, must be empty otherwise**), `breed` ≤ 80, `allergies` ≤ 500, `notes` ≤ 500, archive `reason` ≤ 280. A blank string is stored as `null`.
- **Age is derived, never stored.** `ageMonths` and `ageLabel` are computed at read time in the business timezone (`America/Mexico_City` by default) and are non-null **whenever `birthDate` is set, in every response that carries a pet, write responses included**; `null` otherwise. Show `ageLabel` as is: `«10 meses»`, `«3 años»`, `«1 año 4 meses»`, `«menos de 1 mes»`; with `MONTH` or `YEAR` precision it is prefixed `«~»` (`«~10 meses»`). Do not compute age in the client.
- **Every write** (create, PATCH, archive, restore) returns the **complete pet** (new `version`, age fields) plus `"warnings": string[]` (empty when none): replace your cached copy, no refetch needed. `GET` returns an array of pets without `warnings`.

### Age input (`approxAge` or an exact date)

Send **either** `birthDate` + `birthDatePrecision`, **or** `approxAge`, never both (`400`):

| You send | Stored |
| --- | --- |
| `"birthDate": "2024-03-15", "birthDatePrecision": "EXACT"` | as sent |
| `"birthDate": "2024-03-20", "birthDatePrecision": "MONTH"` | day forced to `01` |
| `"birthDate": "2024-03-20", "birthDatePrecision": "YEAR"` | January 1 |
| `"approxAge": { "months": 10 }` | first day of (today − 10 months), `MONTH` |
| `"approxAge": { "years": 3 }` | January 1 of (current year − 3), `YEAR` |
| `"approxAge": { "years": 1, "months": 4 }` | first day of (today − 16 months), `MONTH` |

`approxAge`: whole numbers, `years` 0–50 and/or `months` 0–600, at least one. `birthDate` is `YYYY-MM-DD`, a real date, not in the future; the precision is required with a date and invalid without one. The response returns the stored `birthDate`, so to edit an approximate age show `ageLabel` and let the user pick a new `approxAge` instead of rebuilding it from `birthDate`.

## 3. POS pet routes (`/customers/:customerId/pets`)

`customerId` and `petId` are UUIDs (`400` otherwise). An unknown customer → `404 CUSTOMER_NOT_FOUND`; an unknown pet or one of another customer → `404 PET_NOT_FOUND`.

### 3.1 `GET /customers/:customerId/pets?status=ACTIVE|ARCHIVED|ALL`

→ `200 [Pet, …]`. Default `ACTIVE`, sorted by name (accents and case ignored). `ARCHIVED` is sorted by `archivedAt` descending, `ALL` newest first; both are capped at **100** rows (the list is not paginated). A `status` outside the three values → `400`.

### 3.2 `POST /customers/:customerId/pets` — create

```json
{ "name": "Bruno", "species": "DOG", "breed": "Chihuahua", "size": "SMALL",
  "approxAge": { "months": 10 }, "allergies": "Pollo" }
```

→ **`201`** complete pet + `warnings`; `createdVia` is `POS`. `name` and `species` are required, the rest optional (`null` = absent). Unknown members are rejected (`400`). At 20 active pets → `422 PET_LIMIT_REACHED`.

### 3.3 `PATCH /customers/:customerId/pets/:petId` — edit

`version` (the pet's current version) is **required**; every other member is optional.

```json
{ "version": 3, "allergies": null, "notes": "Nervioso con el ruido" }
```

→ `200` complete pet + `warnings`.

- **Absent = unchanged.** Send only what changed.
- **`null` clears** a nullable field: `breed`, `size`, `allergies`, `notes`, `speciesOther`, and `"birthDate": null` (clears the date and its precision). This is how the POS removes an allergy.
- **`null` on `name` or `species` → `400`.**
- Changing `species` away from `OTHER` clears `speciesOther` by itself; changing to `OTHER` needs `speciesOther`.
- PATCH of an `ARCHIVED` pet → `422 PET_ARCHIVED` (restore first).

### 3.4 `POST …/:petId/archive` and `POST …/:petId/restore`

```json
{ "version": 3, "reason": "Falleció" }
```

`reason` is optional (≤ 280). → `200` complete pet (`status: "ARCHIVED"`, `archivedAt`, `archivedReason`). Archiving an archived pet → `422 PET_ARCHIVED`. Archiving does not touch the pet's sale lines or history.

```json
{ "version": 4 }
```

Restore → `200` complete pet (`status: "ACTIVE"`, `archivedAt` / `archivedReason` back to `null`) + `warnings`. Restoring an active pet → `422 PET_NOT_ARCHIVED`; past 20 active pets → `422 PET_LIMIT_REACHED`.

### 3.5 `DELETE /customers/:customerId/pets/:petId?version=N` — real erasure

- Permission `delete:Customer`. **`version` is a query parameter, never a body**; missing or not an integer ≥ 1 → `400`.
- → **`204`**, no body. Works on an ACTIVE or an ARCHIVED pet. Stale version → `409 PET_VERSION_CONFLICT`. Already deleted → `404 PET_NOT_FOUND`.
- It deletes the pet row and, in the same transaction, clears the pet from its sale lines (`petId` and the stored name/species snapshot), so nothing identifying the pet remains. The lines, products and amounts stay; those lines now read `pet: null` (§6). Show a confirmation that says it cannot be undone and offer **archive** as the normal alternative.

### 3.6 Warnings

`warnings` is `[]` or `["PET_NAME_DUPLICATE"]`. It appears on **create, on PATCH when the name changes, and on restore** when another **ACTIVE** pet of the same customer has the same name (case and accents ignored, spaces collapsed). The write **succeeded**: show a soft notice («Ya hay otra mascota llamada Bruno»), not an error. Several active pets with the same name are allowed (owner decision).

### 3.7 `409 PET_VERSION_CONFLICT`

```json
{ "statusCode": 409, "error": "PET_VERSION_CONFLICT", "message": "PET_VERSION_CONFLICT", "currentVersion": 4 }
```

Returned by PATCH, archive, restore and DELETE when `version` is not the pet's current one (someone else, or the bot, edited it). Handle it like the other `*_VERSION_CONFLICT`: reload the pets (`GET`), show the new state, and let the user retry with the new `version`. `currentVersion` is at the body root.

### 3.8 `400` per-field format

Field validation uses the **same body as the customer create/update endpoints**: the standard Nest validation error, `message` is an array with one entry per field:

```json
{ "statusCode": 400, "error": "Bad Request",
  "message": [ { "property": "name", "children": [], "constraints": { "maxLength": "name must be shorter than or equal to 60 characters" } } ] }
```

Cross-field rules use the same shape with their own constraint key, e.g. `birthDate` in the future (`birthDateInFuture`), `birthDatePrecision` without a date or a date without precision, `approxAge` together with `birthDate` (`approxAgeConflict`), `speciesOther` required or not allowed. Map by `property` to the form field.

### 3.9 Error table (pet routes)

| HTTP | `error` | When |
| --- | --- | --- |
| 400 | per-field validation (§3.8) | lengths, enums, dates, `approxAge`, `speciesOther`, `null` on `name`/`species`, missing `version`, non-UUID ids, bad `?status=` or `?version=` |
| 404 | `CUSTOMER_NOT_FOUND` | unknown customer in the path |
| 404 | `PET_NOT_FOUND` | unknown pet, pet of another customer or sucursal, already deleted |
| 409 | `PET_VERSION_CONFLICT {currentVersion}` | stale `version` |
| 422 | `PET_ARCHIVED` | PATCH or archive of an archived pet |
| 422 | `PET_NOT_ARCHIVED` | restore of an active pet |
| 422 | `PET_LIMIT_REACHED` | create or restore past 20 active pets |

Pet errors have the code-only body `{ "statusCode", "error", "message" }` with `error === message`. Switch on `error`, never on `message`.

## 4. Customers: `activePetsCount`, search and `matchedPetName`

### 4.1 `GET /customers/:id` — `activePetsCount`

The customer detail gets an additive `activePetsCount` (integer: number of **ACTIVE** pets, archived ones not counted). `GET /customers` list items and the create/update responses do **not** carry it.

### 4.2 `GET /customers?search=` — new

**This parameter did not exist before**: `GET /customers` used to return every customer. Without `search` (or with an empty one) the behavior is unchanged except for the new `matchedPetName: null` on every item. The list has no pagination and is sorted newest first (`createdAt` descending), with or without `search`.

Matching rules, exactly as implemented:

- `search` is trimmed and cut to 100 characters. A repeated parameter (`?search=a&search=b`) is not a usable term: it behaves as no search.
- **Own fields:** the term is split on whitespace (at most **6 words**, the rest are ignored) and **every word must match** at least one of the customer's `firstName`, `lastName`, `email`, `phone` or `businessName` with «contains». The comparison is **case-insensitive but accent-sensitive** (`jose` does not match `José`). `%`, `_` and `\` are matched literally. The phone is stored as digits only and the term is not normalized, so type digits (`5512`), not `+52 55 12`.
- **Pets:** a customer also matches when one of its **ACTIVE** pets has a name that contains the **whole term**, **accent- and case-insensitively** with spaces collapsed (`bruno` and `BRUNÓ` both match `Bruno`). Archived pets never match.
- A customer matching both ways is listed once.

`matchedPetName` on **every** list item:

| Value | When |
| --- | --- |
| `"Bruno"` | the customer matched **only through a pet**: the name of the matching ACTIVE pet (if several match, the first by name, then oldest) |
| `null` | the customer matched on its own fields (even if a pet also matches), or there is no search |

Use it to show «Bruno (mascota de Ana Pérez)» in the picker. Items are otherwise the same shape as before (customer fields, `globalPriceList`, `addresses`) plus `matchedPetName`.

## 5. Pet on a sale line (POS drafts)

Rules (both routes):

- The pet must be an **ACTIVE pet of the sale's customer**. Unknown id (or another sucursal's) → `404 PET_NOT_FOUND`; a pet of another customer, or **any `petId` on a sale without a customer** → `422 PET_CUSTOMER_MISMATCH`; an archived pet → `422 PET_ARCHIVED`.
- The line stores a **snapshot** of the pet's name and species when it is assigned; a later rename does not change the line. Archiving the pet later does not touch existing lines.
- There is **one line per product/variant** (adding the same product stacks the quantity), so a line has one pet.

### 5.1 `POST /sales/drafts/:id/items` — add item with a pet

Body of the existing route plus an optional `petId`:

```json
{ "productId": "uuid", "variantId": null, "quantity": 2, "petId": "8d0e0f6e-5b87-4c2c-8d3a-1f6f0c7a9b11" }
```

- `petId` **absent**: the line keeps whatever pet it has (a stacked line keeps its pet); a UUID assigns it (to the new line or to the stacked one); `null` clears it.
- A non-UUID `petId` → `400`.
- → `200`, the draft response as before, with the line's `pet` (§6).

### 5.2 `PUT /sales/drafts/:id/items/:itemId/pet` — change the pet of a line

```json
{ "petId": "8d0e0f6e-5b87-4c2c-8d3a-1f6f0c7a9b11" }
```

`petId` is **required**: a UUID assigns the pet, **`null` clears it** (`{ "petId": null }`). → `200` the complete draft response (the same shape as the other draft routes) with the updated `pet` on the line. `itemId` is the line's `id` (UUID). An `itemId` that is not a line of the draft → `422 SALE_ITEM_NOT_FOUND` (the sales module's body `{ statusCode, error, message, timestamp }`); a sale that is not a draft of the user is refused like the other draft routes.

### 5.3 `PUT /sales/drafts/:id/customer` — `petsCleared`

Changing the draft's customer **clears every line's pet** (the pets belong to the previous customer). The response of this route is the draft response plus a boolean:

```json
{ "id": "…", "customerId": "…", "items": [ { "…": "…", "pet": null } ], "…": "…", "petsCleared": true }
```

- `petsCleared: true` **only when some line really lost a pet**; `false` otherwise (no line had a pet, or the **same** customer was assigned again, which keeps the pets). Use it to show «Se quitaron las mascotas de las líneas porque cambió el cliente».
- **`DELETE /sales/drafts/:id/customer` stays `204` with no body** and clears the line pets **server-side** too; refetch the draft (`GET /sales/drafts`) to see the lines. It does not return `petsCleared`.

## 6. `pet` on sale lines (responses)

Every sale line carries a `pet` member:

```json
{ "pet": { "id": "8d0e0f6e-5b87-4c2c-8d3a-1f6f0c7a9b11", "name": "Bruno", "species": "DOG", "status": "ACTIVE" } }
```

| `pet` | Meaning |
| --- | --- |
| `{ id, name, species, status }` | `id`, `name`, `species` come from the **snapshot** of the assignment; **`status` is the pet's current status** (`ACTIVE` or `ARCHIVED`): show the name always, and an «archivada» badge if you want |
| `{ "id": null, "name": "Bruno", "species": "DOG", "status": null }` | the pet row is gone only because the **customer was deleted**: the snapshot stays, `id` and `status` are `null` |
| `null` | no pet on the line, old lines, or lines of a pet that was **really deleted** (§3.5). It is `null`, never an object of nulls |

Where it appears: on `items[]` of **every draft response that returns the draft** (`POST /sales/drafts`, `GET /sales/drafts`, add item, update quantity, `PUT …/items/:itemId/pet`, `PUT …/customer` and the other draft mutations: they all serialize the lines the same way) and on `items[]` of **`GET /sales/:id`** (the sale detail, confirmed or not). The **rows of `GET /sales`** (the list) have no lines, so no `pet`.

**Ticket:** the printed ticket has **no pet in v1**. In the sale detail and in the history show «Para: <nombre>» from `pet.name` on the line (when `pet` is not `null`). Every line keeps its fixed copy for a future ticket.

## 7. POS history of one pet: `GET /sales?customerId=<uuid>&petId=<uuid>`

The customer card's sales history (`GET /sales?customerId=…`, same params and response as today) accepts `petId` to show the sales **of one pet**: confirmed sales with **at least one line for that pet** (a sale with two lines for the pet is one row). The returned sales are listed as usual (the list rows carry no lines; open one with `GET /sales/:id` to see each line's `pet`).

- **Needs exactly one `customerId`.** `petId` with no `customerId`, or with more than one → **`400 PET_FILTER_REQUIRES_CUSTOMER`**. Code-only body like the pet errors: `{ "statusCode": 400, "error": "PET_FILTER_REQUIRES_CUSTOMER", "message": "PET_FILTER_REQUIRES_CUSTOMER" }`; match on **`error`**.
- A `petId` that is not one of **that customer's** pets (unknown, another customer's, another sucursal's) → **`404 PET_NOT_FOUND`** (`{ statusCode, error: "PET_NOT_FOUND", message: "PET_NOT_FOUND" }`), **never an empty list**. A pet of that customer with no sales → `200` with an empty `data`.
- A `petId` that is not a UUID → `400` (per-field).
- **What narrows and what does not** (the KPI cards must not change when a pet is selected):
  - **Narrow to the pet:** `data`, `pagination.total` / `totalPages` and `filterSummary` (`count`, `totalCents`, `debtCents`).
  - **Stay customer-wide:** `counts` (`all`, `pendingPayments`, `notDelivered`) and **`summary`** (`salesCount`, `totalSoldCents`, `outstandingDebtCents`).

  So with a pet selected `summary.salesCount` ≥ `pagination.total`.
- It combines with the other filters (status, dates, …) as they combine today.

Archived pets can be selected too (their old sales stay). A **really deleted** pet no longer matches: its id is `404 PET_NOT_FOUND`, and its former lines read `pet: null`.

## 8. Error table (sale and history routes)

| HTTP | `error` / body | Route |
| --- | --- | --- |
| 400 | per-field validation | non-UUID `petId` (add item, `PUT …/pet`, `GET /sales`) |
| 400 | `PET_FILTER_REQUIRES_CUSTOMER` | `GET /sales?petId=` without exactly one `customerId` (§7) |
| 404 | `PET_NOT_FOUND` | draft routes: unknown pet; `GET /sales?petId=` of another customer or unknown |
| 422 | `PET_CUSTOMER_MISMATCH` | draft routes: pet of another customer, or a sale without customer |
| 422 | `PET_ARCHIVED` | draft routes: assigning an archived pet |
| 422 | `SALE_ITEM_NOT_FOUND` | `PUT …/items/:itemId/pet` with an item that is not in the draft |

The first three pet codes have the code-only body `{ "statusCode", "error", "message" }` (`error === message`).

## 9. Test data and notes

- Pets created by the bot appear in the same routes with `createdVia: "CHATBOT"`; staff can edit, archive or delete them. The bot reads pets on every turn: there is **no realtime event** when staff edit one, so refetch the list when the card opens.
- When a customer is deleted (`DELETE /customers/:id`) its pets are deleted with it; their old sale lines keep the snapshot and read `status: null` (§6).
- Nothing is printed: the ticket and the receipt are unchanged.
