# Editorial publish and discard HTTP contract — v0.1 (C3.2, proposal)

Status: draft for joint BE/FE review. Nothing here exists yet. Neither side
writes code or mocks against it until it is closed.

Scope: publish and discard of the editorial draft. Out of scope: product media
(§3.2 of `catalog-editorial-editor-contract-proposal.md`) and how the public
catalog reads Published (next slice, C3.3).

Base: `main` 3f02f6f. Same conventions as the editor contract: Bearer JWT →
tenant guard, actor and tenant from the token only, `Cache-Control: no-store`
on every response, error envelope `{ statusCode, error }` with `MALFORMED` 400,
`UNAUTHORIZED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT` 409,
`INTERNAL_ERROR` 500. `Idempotency-Key` header is required, 1–200 characters,
kept untrimmed.

## 0. Decided

- The only consumer of the published document is the public catalog. POS keeps
  using operational product data.
- Delivered in slices: (1) publish and discard as state transitions, no
  consumer wired; (2) the public catalog reads Published (C3.3); media later.

## 1. State model (unchanged shape)

Both operations return the existing `EditorialState` (§1 of the editor
contract). Draft and Published live in one state row per product, so:

- Publish copies the draft document into Published, sets
  `published.revision` to the previous revision + 1 (1 when nothing was
  published) and removes the draft (`draft: null`). `cycle` is kept.
- Discard removes the draft (`draft: null`). Published is unchanged. `cycle` is
  kept.
- After either, the next `initialize` uses `expectedCycle` equal to the current
  `cycle`, as today. A stale request from the consumed draft cannot match a
  later draft because initialize increments the cycle.
- Only the latest Published document is kept. There is no publication history
  endpoint in this phase.

## 2. Endpoints

### 2.1 Publish

`POST /products/:productId/editorial/draft/publish` → `200 EditorialState`

```ts
type PublishBody = { expectedCycle: number; expectedRevision: number };
```

- Closed body: both fields positive integers, no other keys, no query
  parameters.
- CAS: `expectedCycle` and `expectedRevision` must match the active draft
  exactly. No `expectedPublishedRevision`: while a draft is active, Published
  only changes by publishing that draft, so the draft revision already pins it.
- The stored draft is revalidated against the current context before
  publishing (variants, vocabulary codes and units, selected assets) with the
  same rules and limits as a fresh save. An invalid draft is never published:
  `400 MALFORMED`, nothing changes. Previously saved does not mean valid now.
- Archived options: a value using an archived option is accepted only when the
  identical assignment is already in the current Published document (the same
  conservation rule as save, with Published as the baseline). Publishing never
  introduces a new archived value.
- Completeness: see open item Q1.

### 2.2 Discard

`POST /products/:productId/editorial/draft/discard` → `200 EditorialState`

```ts
type DiscardBody = { expectedCycle: number; expectedRevision: number };
```

- Same closed body and CAS as publish.
- No document validation: discard is the way out for a draft that can no
  longer be saved or published.

### 2.3 Errors (both)

| Case                                                           | Response           |
| -------------------------------------------------------------- | ------------------ |
| Malformed body, header or `productId`; invalid draft (publish) | `400 MALFORMED`    |
| Missing or invalid token                                       | `401 UNAUTHORIZED` |
| Missing permission (§3), inactive user, no membership          | `403 FORBIDDEN`    |
| Product not found in the current tenant                        | `404 NOT_FOUND`    |
| No active draft; stale `expectedCycle` or `expectedRevision`   | `409 CONFLICT`     |
| Same `Idempotency-Key` with a different body                   | `409 CONFLICT`     |

### 2.4 Idempotency and replay

- Each operation has its own receipt namespace, keyed by tenant, product,
  actor and `Idempotency-Key`.
- Same key and same body → `200` with the recorded result. A replay never
  restores an older state and never republishes.
- Replay still rechecks authority (§3) and that the product exists.

## 3. Permissions

- Publish: new exact permission `ProductEditorialDraft:publish`, plus
  `ProductEditorialDraft:read`. It does not require `update`, so a reviewer who
  publishes but does not edit is possible. See Q2.
- Discard: `ProductEditorialDraft:read` + `:update`, like save.
- Granted manually only, like the existing editorial permissions. `manage:all`
  and Product permissions are not editorial grants.

## 4. Concurrency

Same coordination as save: tenant-qualified Product `FOR UPDATE` as the
serialization point, then receipts and state, in one ReadCommitted
transaction. Publish additionally reads variants, vocabulary and selected
assets with the existing locked readers before validating.

## 5. Open items

- **Q1 (product decision): what must a draft contain to be published?** Today
  an incomplete document is valid capture data (null title, null description,
  null family, no attributes). Options: (a) no extra rule, a valid draft can be
  published as is; (b) require a non-empty title; (c) require title and family.
  Proposal: (b).
- **Q2 (product decision): who may publish?** Proposal: a separate `publish`
  permission (§3). Alternative: anyone with `update` can publish.
- **Q3 (FE):** confirm paths, bodies, `200` responses and that both operations
  returning `draft: null` fits the editor flow.
