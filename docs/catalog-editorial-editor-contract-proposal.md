# Editorial editor HTTP contract — v3.2 (§1–§2 and §3.1 closed at a36e903; §3.3 added)

Status: draft for joint BE/FE review. Nothing here exists yet except the read
endpoint in §1. Neither side writes code or mocks against §2–§4 until this is
closed.

Base: `origin/main` e3c115d. Every endpoint uses the existing auth chain
(Bearer JWT → tenant guard); actor and tenant come from the token, never from
headers or body. All responses carry `Cache-Control: no-store`.

## 1. Already live after deploy (H1)

`GET /products/:productId/editorial` → `200`

```ts
type EditorialState = {
  cycle: number | null; // null only when the product has no editorial state
  draft: {
    revision: number; // positive integer
    basePublishedRevision: number | null; // published revision the draft started from
    document: EditorialDocument; // §2.2
  } | null;
  published: { revision: number; document: EditorialDocument } | null;
};
```

```json
{
  "cycle": 1,
  "draft": {
    "revision": 1,
    "basePublishedRevision": null,
    "document": {
      "commercialTitle": null,
      "description": null,
      "mediaRefs": [],
      "familyCode": null,
      "values": []
    }
  },
  "published": null
}
```

That is exactly what initialize produces for a product with nothing published
(`emptyDocument()` in `domain/document.ts`). A product never initialized:
`{ "cycle": null, "draft": null, "published": null }`.

GET returns the document as stored and does not re-validate it. New writes
through the core validate the full five-key shape. That is NOT a guarantee about
data stored earlier: a previous handoff conserved a Published `{}` and a legacy
create path, and no deployed data was inspected. The editor treats a stored
document that does not match §2.2 as unreadable, without inventing or
normalizing fields. GET never returns `warnings`.

## 2. Phase A — expose the existing core, plus the new limits

The core already implements these writes. This phase adds HTTP and the new
document limits of §2.2, which are decided but NOT enforced today
(implementation pending). The core
also has an internal `create(document)`; it is NOT exposed: the editor flow is
initialize (from published or empty) and then save. CORS already reflects
requested headers (`enableCors()` defaults), so `Idempotency-Key` passes the
preflight.

| Operation  | Method and path                                        | Body                                            | Success |
| ---------- | ------------------------------------------------------ | ----------------------------------------------- | ------- |
| Initialize | `POST /products/:productId/editorial/draft/initialize` | `{ expectedCycle }`                             | `201`   |
| Save       | `PUT /products/:productId/editorial/draft`             | `{ expectedCycle, expectedRevision, document }` | `200`   |

- **Initialize** starts a new draft (revision 1, next cycle) from the current
  published document, or from the empty document if nothing is published. It
  takes no document. It fails with `409` if a draft already exists.
- **Save** replaces the whole draft document and increments the revision.
- `expectedCycle` is `null` when the product has no editorial state yet
  (`cycle: null` in GET); otherwise the current cycle. `expectedRevision` is the
  draft revision the editor loaded.
- Response body: `EditorialState`, plus optional `warnings` (§2.3).

### 2.1 Idempotency and replay

Header `Idempotency-Key` (same name as cash-register), required on both
writes: 1–200 characters, sent as-is (not trimmed).

- Scope: tenant + product + actor + key. Initialize and save have separate key
  spaces.
- Same key, different body → `409 CONFLICT`.
- Same key and same body → the RECORDED result of that request, with the same
  status (`201` initialize, `200` save). It is the historical state at the time
  of the original write, not the current state.
- What a replay re-checks is established only by these existing tests, not as
  a general guarantee. The PostgreSQL ones last ran against disposable targets
  that are now retired; they were not re-run for this proposal.
  - Save: `d16-save.integration.spec.ts:145` (a matching replay does not restore
    a newer draft and rechecks current gates); `isolated-postgres.spec.ts:436`
    (replay before the revision check, without replacing a newer document);
    `isolated-postgres.spec.ts:494` (rechecks current private references, keeps
    media order); `prisma-editorial-write-transaction.spec.ts:715` (keeps an
    archived assignment on a nonempty save replay; mocked, not SQL).
  - Initialize: `d16-initialize.integration.spec.ts:42` (copies an archived
    Published with provenance and warnings; a replay never restores a newer
    draft).
  - Both: `isolated-postgres.spec.ts:205` (a mismatched receipt payload or
    cycle is rejected).

  So a replay can fail (`403`, `400`) even though the original write
  succeeded. Anything not covered above is not promised.

FE rules:

- Every new attempt the user confirms uses a new key and the expected
  cycle/revision the editor currently holds.
- An ambiguous retransmission (network failure, no response) resends the same
  key and the exact same body. A later GET does not prove the first attempt
  succeeded.
- A replay response is an acknowledgement of that attempt. It must not
  overwrite the local buffer or the expected state without telling it apart
  from a fresh reload.

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
  variantId: string | null; // product ⇒ null; sellable ⇒ a variant id when the product has variants, else null
} & (
  | { type: 'text'; value: string }
  | { type: 'boolean'; value: boolean }
  | { type: 'number'; value: number; unit: string | null } // finite; unit from the definition's allowed units
  | { type: 'single'; value: string } // option code
  | { type: 'multi'; value: string[] } // unique option codes
);
```

Rules the backend enforces (FE mirrors them to avoid round trips):

- Every key is required, including the nullable ones; no extra keys.
- One value per `[code, variantId]`.
- `code`, `owner` and `type` must match a definition bound to the selected
  family.
- Archived options: a value may keep an archived option only if the SAME
  assignment — same family, definition code, owner, variant, type and option —
  is already in the stored draft (the baseline). An archived option cannot be
  introduced, moved to another variant, or re-added after removal. Initialize
  from published keeps the published assignments under the same rule. Selectors
  hide archived options for new assignments and still show kept ones.
- Limits (decided by the user; implementation pending, NOT enforced today):
  `commercialTitle` ≤ 200 characters, `description` ≤ 20 000 characters
  (characters = Unicode code points), `mediaRefs` ≤ 20 entries, `values` ≤ 200
  entries. Text values have no limit of their own beyond the body size.
  Where they will apply: ONLY to the caller's document in a fresh save (a new
  key), rejecting with `400 MALFORMED` before anything is written. They do NOT
  apply to GET, to a replay (the recorded acknowledgement is returned as it
  was), or to the document initialize copies from Published. Nothing is
  trimmed or normalized. Consequence: a draft initialized from a Published
  document over the limits can be read, but saving it requires bringing it
  within the limits. Tests will cover the boundaries, including code points
  outside the BMP (an emoji counts as one character).
- Request body ≤ 100 kB of serialized JSON, in bytes (UTF-8). This is the
  existing framework default, not new.

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

The write succeeded; the warning says a kept value uses an option that is now
archived. `familyId` and `definitionId` are ids, which the vocabulary endpoint
(§3.1) returns next to each code so the editor can map them. An empty list is
omitted.

### 2.4 Errors

Errors produced by the editorial controller or its guards use exactly
`{ "statusCode", "error" }` (no `message`, no `timestamp`). This is NOT the
global `{ statusCode, error, message, timestamp }` envelope.

| Status | `error`          | Meaning for the editor                                                    |
| ------ | ---------------- | ------------------------------------------------------------------------- |
| 400    | `MALFORMED`      | Invalid body, key or document (no detail about which field)               |
| 401    | `UNAUTHORIZED`   | Missing or invalid token                                                  |
| 403    | `FORBIDDEN`      | No editorial permission, or product not visible in this tenant            |
| 404    | `NOT_FOUND`      | Product not found after authorization                                     |
| 409    | `CONFLICT`       | Stale cycle/revision, draft already exists, race, or key reused otherwise |
| 500    | `INTERNAL_ERROR` | Unexpected                                                                |

Outside that envelope: invalid JSON, a body over 100 kB (`413`) and unmatched
routes are rejected by the framework before the controller, with the
framework's own body. The editor treats any non-2xx response without the
editorial envelope as a generic failure.

`409` does not say which cause it was, and the backend cannot tell the editor.
A GET only shows the current state; it does not diagnose the cause. On `409`
the editor keeps the local buffer, shows that the draft could not be saved, and
offers an explicit action to reload and reconcile against the current GET. No
autosave, no automatic retry and no key renewal by deduction.

## 3. Phase B — new backend work an editor needs

Without these the editor cannot list vocabulary or attach images.

### 3.1 Vocabulary (read-only)

`GET /catalog-editorial/vocabulary` → `200`, permission
`ProductEditorialDraft:read`, company-wide (not per tenant or product).

```ts
type Vocabulary = {
  families: Array<{
    id: string;
    code: string;
    label: string; // new
    bindings: Array<{
      definitionId: string;
      definitionCode: string;
      owner: 'product' | 'sellable';
      sortOrder: number; // new: order of attributes inside the family
    }>; // may be []
  }>; // ordered by label, then code
  definitions: Array<
    { id: string; code: string; label: string } & (
      | { type: 'text' }
      | { type: 'boolean' }
      | {
          type: 'number';
          units: Array<{
            code: string | null;
            label: string | null;
            sortOrder: number;
          }>; // required, may contain code null
        }
      | {
          type: 'single' | 'multi';
          options: Array<{
            code: string;
            label: string;
            archived: boolean;
            sortOrder: number;
          }>; // required, may be []
        }
    )
  >;
};
```

`label` and `sortOrder` do not exist yet: Phase B adds them with a migration
(decided by the user). Labels come from the backend; the editor does not keep
its own label map. Archived options are listed with `archived: true` so kept
values can be shown. There is no vocabulary version field.

Stable order of every array: families by `label`, then `code`; bindings,
options and units by `sortOrder`, then code (a `null` unit code first);
definitions by `code`.

Vocabulary content is loaded by a versioned, idempotent seed in the repository
(decided by the user); changes go through PRs. Running it against any real
database is a separate authorization.

### 3.2 Product media — outline only

| Operation | Method and path                                         | Notes                                                                   |
| --------- | ------------------------------------------------------- | ----------------------------------------------------------------------- |
| Upload    | `POST /products/:productId/editorial/media` (multipart) | JPEG, PNG or WebP, 1 byte to 10 MiB (existing schema and domain limits) |
| List      | `GET /products/:productId/editorial/media`              | Needs a new repository query                                            |
| Read      | `GET /products/:productId/editorial/media/:assetId`     | Streams bytes; authenticated, no public URL                             |

Not specified yet, and required before any mocks: list shape, permissions,
error codes, behavior when storage is not configured, caching, binary response
headers and how the editor fetches images safely with the token.

Requires wiring private storage configuration (S3/Spaces) for the API, which
today exists only as an offline factory. That configuration and a privacy proof
against real storage need their own authorization.

### 3.3 Editorial context (variants)

The product endpoints that list variants require `read:Product`
(`products.controller.ts:98–99`), which an editorial-only user may not have.

`GET /products/:productId/editorial/context` → `200`. Same authorization as
§1: exact `ProductEditorialDraft:read`, active user, current tenant membership,
qualified product; no `manage` fallback and no `read:Product`. Same
`{ statusCode, error }` envelope, `Cache-Control: no-store`.

```ts
type EditorialContext = {
  variants: Array<{ id: string; name: string }>; // complete, ordered by name then id; [] = no variants
};
```

- The real variant list decides membership, never the `hasVariants` flag
  (which can disagree with the actual variants): `variants.length > 0` ⇒
  `sellable` values need a `variantId` from this list; `[]` ⇒ `variantId: null`.
  This matches the core rule. The flag is not returned.
- Complete list, no pagination and no silent truncation. Only `id` and `name`
  (no SKU, stock or prices). Duplicate names are possible: the editor keys by
  `id` and may show a short id only as a visual aid.
- It is a current snapshot, not tied to the draft revision. A value whose
  `variantId` is no longer in the list is shown as orphaned and kept until the
  user acts on it; it is never removed silently. This endpoint is not the final
  authority: save revalidates and rejects with `400` if the orphan is still
  there.

## 4. Phase C — publish (later phase)

The core cannot publish: published content only changes through code that does
not exist yet. Publishing needs a new core operation, a new permission and a
decision on what consumes the published document (public catalog, POS, both).

## 5. Decisions and open items

Decided by the user:

- Publish is a later phase.
- Editorial permissions are granted MANUALLY only, for now: no role gets
  `ProductEditorialDraft:read` or `:update` automatically (changed from the
  earlier "tenant admin by seeder" decision: no canonical tenant admin role
  exists). `manage:all` is still NOT an editorial grant.
- Images: JPEG, PNG, WebP up to 10 MiB, the limits already in the schema.
- Explicit document limits as in §2.2.
- Vocabulary gets `label` and `sortOrder` in the backend.
- Vocabulary is loaded by a versioned seed.

Accepted by FE: Q3 (generic `400`, with mirrored client validation and a
preserved buffer), Q5 (paths, methods, header, `201`/`200` including replay)
and §3.1 vocabulary.

Closed by FE at a36e903: §1–§2 and §3.1.

Open:

- §3.3 editorial context: FE confirmation of v3.2.
- §3.2 media details before mocks.
