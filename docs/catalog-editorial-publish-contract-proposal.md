# Editorial publish and discard HTTP contract — v0.3 (C3.2, closed)

Status: closed by BE and FE (v0.2 aca9fbb plus the exact title rule in §2.1).
Nothing here is implemented yet; FE may mock exactly this contract.

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
  `cycle`, as today, and creates the new draft with `cycle + 1` and revision 1
  (`prisma-catalog-editorial.ts:542`). So a `(cycle, revision)` pair is never
  reused: a stale tab holding `{ expectedCycle: N, expectedRevision: r }` gets
  `409 CONFLICT` against the new draft of cycle `N + 1`, for save, publish and
  discard alike. Required test: publish or discard, initialize, then a stale
  save, publish and discard with the old pair each return `409` and change
  nothing.
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
- Completeness (interim): publish is rejected with `400 MALFORMED` when
  `commercialTitle` is `null` or when `commercialTitle.trim() === ''`
  (ECMAScript `String.prototype.trim`: Unicode white space and line
  terminators, the same set as `\s`). So `null`, `""` and `"   "` are
  rejected. The document is published exactly as stored, never trimmed. This is an interim minimum until the per-family
  publication minimums approved as D14 exist in the real vocabulary (today only
  `starter.general`); it is not the final rule.
- Media: until the media slice exists, a draft with a non-empty `mediaRefs` is
  rejected with `400 MALFORMED`. Published never carries media refs in this
  phase.
- Revalidation and the copy to Published run under the same Product lock and
  in the same transaction, like save (§4): no validate–delete–publish race.

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

The envelope is exactly `{ statusCode, error }`, no extra fields. A publish
`400` does not say what is missing; the editor prevalidates with the same
rules.

### 2.4 Idempotency and replay

- Each operation has its own receipt namespace, keyed by tenant, product,
  actor and `Idempotency-Key`.
- Same key and same body → `200` with the recorded result. A replay never
  restores an older state and never republishes.
- Replay still rechecks authority (§3) and that the product exists.

## 3. Permissions

- Publish: new exact permission `ProductEditorialDraft:publish`, plus
  `ProductEditorialDraft:read`. It does not require `update`, so a reviewer who
  publishes but does not edit is possible, and an editor without `publish` can
  save but not publish. Permission code as returned to the FE (the existing
  `action:subject` format): `publish:ProductEditorialDraft`.
- Discard: `ProductEditorialDraft:read` + `:update`, like save.
- Granted manually only, like the existing editorial permissions. `manage:all`
  and Product permissions are not editorial grants.

## 4. Concurrency

Same coordination as save: tenant-qualified Product `FOR UPDATE` as the
serialization point, then receipts and state, in one ReadCommitted
transaction. Publish additionally reads variants, vocabulary and selected
assets with the existing locked readers before validating.

## 5. Decisions

- Q1 (user): interim minimum is a non-empty title (§2.1); D14 per-family
  minimums replace it when those families exist.
- Q2 (user, matches the approved acceptance scenario): separate `publish`
  permission (§3).
- Q3 (FE): paths, bodies, `200` responses and `draft: null` accepted.
- B1 (FE): no `(cycle, revision)` reuse, by the existing cycle increment on
  initialize, pinned by the stale-tab test (§1).
- O2 (FE): archived option conserved in the draft but absent from the current
  Published can be saved and cannot be published.
- O3 (FE): non-empty `mediaRefs` rejected on publish until the media slice.
