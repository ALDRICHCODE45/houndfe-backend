# Editorial context

`GET /products/:productId/editorial/context` returns the closed contract §3.3
shape, with the complete current variant list ordered by name, then id:

```json
{
  "variants": [
    { "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "name": "Same" },
    { "id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "name": "Same" }
  ]
}
```

No variants: `{ "variants": [] }`. No pagination, SKU, stock, price or
`hasVariants` flag. The real list decides membership: a nonempty list requires
sellable values to use a listed variantId; an empty list requires null.
This snapshot is independent of draft revision. Preserve orphaned draft values
visibly until the user acts; save revalidates, rejecting remaining orphans.

JWT and tenant guards derive actor/tenant exclusively from the principal.
Unchanged H1 authority requires an active user, current qualified tenant
membership, exact `ProductEditorialDraft:read` and a qualified product. Neither
`manage:all` nor `read:Product` is an editorial grant. Foreign/missing products
fail with `403 FORBIDDEN` during authority resolution; disappearance before the
subsequent qualified SQL snapshot yields `404 NOT_FOUND`.

The product parameter must be a UUID. Query strings and unexpected decoded
bodies yield `400 MALFORMED`. Controller/guard failures use exactly
`{statusCode,error}` via the existing editorial filter; missing/invalid JWTs
return `401 UNAUTHORIZED`, unexpected read failures `500 INTERNAL_ERROR`.
Success and these errors carry `Cache-Control: no-store`.

Tests use mocked persistence and synthetic authentication. SQL qualification and
ordering are structurally asserted; no database, SQL or JWT cryptography is run.
