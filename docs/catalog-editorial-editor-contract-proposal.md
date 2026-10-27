# Editorial editor HTTP contract — PROPOSAL v2 (not implemented)

Status: draft for joint BE/FE review. Nothing here exists yet except the read
endpoint in §1. Neither side writes code against §2–§4 until this is closed.

Base: `origin/main` e3c115d. Every endpoint uses the existing auth chain
(Bearer JWT → tenant guard); actor and tenant come from the token, never from
headers or body. All responses carry `Cache-Control: no-store`.

## 1. Already live after deploy (H1)

`GET /products/:productId/editorial` → `200`

```json
{
  "cycle": 1,
  "draft": { "revision": 3, "basePublishedRevision": null, "document": {} },
  "published": null
}
```

Empty product: `{ "cycle": null, "draft": null, "published": null }`.
GET never returns `warnings`.

## 2. Phase A — expose the existing core (no new domain logic)

The core already implements these writes; this phase only adds HTTP. The core
also has an internal `create(document)`; it is NOT exposed: the editor flow is
initialize (from published or empty) and then save. CORS already reflects
requested headers (`enableCors()` defaults), so `Idempotency-Key` passes the
preflight.

| Operation  | Method and path                                        | Body                                            | Success |
| ---------- | ------------------------------------------------------ | ----------------------------------------------- | ------- |
| Initialize | `POST /products/:productId/editorial/draft/initialize` | `{ expectedCycle }`                             | `201`   |
| Save       | `PUT /products/:productId/editorial/draft`             | `{ expectedCycle, expectedRevision, document }` | `200`   |

- **Initialize** starts a new draft from the current published document, or an
  empty one if nothing is published. It takes no document.
- **Save** replaces the whole draft document and increments the revision.
- `expectedCycle` is `null` when the product has no editorial state yet
  (`cycle: null` in GET); otherwise the current cycle. `expectedRevision` is the
  draft revision the editor loaded.
- Response body: the same shape as GET. Save and initialize may add
  `warnings` (see §2.3).

### 2.1 Idempotency

Header `Idempotency-Key` (same name as cash-register), required on both
writes: 1–200 characters, sent as-is (not trimmed).

- Scope: tenant + product + actor + key. Initialize and save have separate key
  spaces.
- Same key and same body → the recorded result is returned again with the same
  status (`201` for initialize, `200` for save). It is rechecked against current
  permissions and vocabulary, so it can still fail.
- Same key, different body → `409 CONFLICT`.
- FE: generate a new key per user action, reuse it only when retrying the
  same request after a network failure.

### 2.2 Document

```ts
type EditorialDocument = {
  commercialTitle: string | null;
  description: string | null;
  mediaRefs: string[]; // private asset IDs of THIS product, unique, not URLs
  familyCode: string | null; // family code, not ID; null ⇒ values must be []
  values: EditorialValue[];
};

type EditorialValue = {
  code: string; // definition code bound to the selected family
  owner: 'product' | 'sellable';
  variantId: string | null; // product ⇒ null; sellable ⇒ a variant id when the product has variants
} & (
  | { type: 'text'; value: string }
  | { type: 'boolean'; value: boolean }
  | { type: 'number'; value: number; unit: string | null } // unit from the definition's allowed units
  | { type: 'single'; value: string } // option code
  | { type: 'multi'; value: string[] } // unique option codes
);
```

Rules the backend enforces (FE should mirror them to avoid round trips):

- Every key is required, including the nullable ones; no extra keys.
- One value per `[code, variantId]`.
- `code`, `owner` and `type` must match a definition bound to the family.
- A new assignment cannot use an archived option. An archived option already
  present in the draft can be kept.
- The validator has no length or count limits today. The only real limit is
  the default JSON body size of 100 kB (Nest/body-parser). See Q4.

### 2.3 Warnings

Save and initialize may return:

```json
{
  "warnings": [
    {
      "code": "ARCHIVED_OPTION",
      "familyId": "…",
      "definitionId": "…",
      "owner": "product",
      "variantId": null,
      "optionCode": "…"
    }
  ]
}
```

The write succeeded; the warning tells the editor that a kept value uses an
option that is now archived.

### 2.4 Errors

Same envelope as the read endpoint: exactly `{ "statusCode", "error" }`.
This is NOT the global `{ statusCode, error, message, timestamp }` envelope.

| Status | `error`          | Meaning for the editor                                                    |
| ------ | ---------------- | ------------------------------------------------------------------------- |
| 400    | `MALFORMED`      | Invalid body, key or document (no detail about which field)               |
| 401    | `UNAUTHORIZED`   | Missing or invalid token                                                  |
| 403    | `FORBIDDEN`      | No editorial permission, or product not visible in this tenant            |
| 404    | `NOT_FOUND`      | Product not found after authorization                                     |
| 409    | `CONFLICT`       | Stale cycle/revision, draft already exists, or key reused with other body |
| 500    | `INTERNAL_ERROR` | Unexpected                                                                |

`409` covers several causes with the same body. The editor tells them apart by
reloading with GET: if `cycle`/`draft.revision` differ from what it loaded, the
draft changed (show reconcile, keep the local buffer); if they are equal, the
key was reused with another body (an FE bug: new key, resend). No autosave or
automatic retry on `409`.

## 3. Phase B — new backend work an editor needs

Without these the editor cannot list vocabulary or attach images.

### 3.1 Vocabulary (read-only)

`GET /catalog-editorial/vocabulary` → `200`

```json
{
  "families": [
    {
      "id": "…",
      "code": "…",
      "bindings": [{ "definitionCode": "…", "owner": "product" }]
    }
  ],
  "definitions": [
    {
      "id": "…",
      "code": "…",
      "type": "single",
      "options": [{ "code": "…", "archived": false }]
    },
    { "id": "…", "code": "…", "type": "number", "units": ["cm", null] }
  ]
}
```

Company-wide vocabulary, permission `ProductEditorialDraft:read`. Bindings are
returned with the definition code for convenience; the stored key is the
definition id. Archived options are listed with `archived: true` so the editor
can show kept values.

Gaps found in the schema: families, definitions, options and units store only a
`code` — no display label, no sort order, no version. The editor can only show
codes unless we add labels (Q7). There is also no way to create vocabulary other
than writing to the database (Q8).

### 3.2 Product media

| Operation | Method and path                                         | Notes                                                                                                               |
| --------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Upload    | `POST /products/:productId/editorial/media` (multipart) | JPEG, PNG or WebP, 1 byte to 10 MiB (existing schema and domain limits); returns `{ assetId, mimeType, sizeBytes }` |
| List      | `GET /products/:productId/editorial/media`              | Needs a new repository query                                                                                        |
| Read      | `GET /products/:productId/editorial/media/:assetId`     | Streams bytes; authenticated, no public URL                                                                         |

Requires wiring private storage configuration (S3/Spaces) for the API, which
today exists only as an offline factory. That configuration and a privacy proof
against real storage need their own authorization.

## 4. Phase C — publish (needs a product decision first)

The core cannot publish: published content only changes through code that does
not exist yet. Publishing needs a new core operation, a new permission and a
decision on what consumes the published document (public catalog, POS, both).

## 5. Decisions and open questions

Decided by the user:

- Publish is a later phase (§4 stays out of this delivery).
- The tenant admin role gets `ProductEditorialDraft:read` and `:update` by
  default (seeder); `manage:all` is still NOT an editorial grant.
- Images: JPEG, PNG, WebP, as the schema already allows.

Open:

- Q3 (FE): generic `400 MALFORMED` is acceptable only with verifiable client
  validation (mirroring §2.2) and a preserved local buffer — confirm.
- Q4 (user): explicit limits to add as contract (title, description, number of
  media and values, body size). Proposed, to be confirmed: title ≤ 200,
  description ≤ 20 000 characters, ≤ 20 media, ≤ 200 values, body ≤ 100 kB.
- Q5 (FE): paths, methods, header — confirm with this v2.
- Q6 (user): keep the existing 10 MiB image limit (proposal) or lower it.
- Q7 (user): add display labels (and sort order) to the vocabulary, or have FE
  map codes to labels.
- Q8 (user): how vocabulary is created (seed, admin screen, import).
