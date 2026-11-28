# 33 — `GET /sales/drafts` rows include `customer` and `shippingAddress`

**Status:** implemented on branch `feat/drafts-customer-summary` (from `main` 053429df). Additive only: no migration, no new permission, no new route.

## Route

`GET /sales/drafts` — permission `read:Sale`. Returns the current user's drafts in the current tenant, newest first (unchanged).

Every row keeps all of its existing keys (`customerId`, `shippingAddressId`, `items`, `totalCents`, `subtotalCents`, `discountCents`, …) with the same values. Each row now also has two keys:

```ts
customer: {
  id: string;
  firstName: string;
  lastName: string | null;
} | null;

shippingAddress: {
  id: string | null;        // shippingAddressId of the draft
  street: string;
  exteriorNumber: string | null;
  interiorNumber: string | null;
  zipCode: string | null;
  neighborhood: string | null;
  municipality: string | null;
  city: string | null;
  state: string | null;
} | null;
```

The shape and the null rules are the same as in the `PUT /sales/drafts/:id/customer` and `PUT /sales/drafts/:id/shipping-address` responses. Both reads use the same mapper in the backend, so the shapes stay the same.

- `customer` is `null` when the draft has no customer.
- `shippingAddress` is the address snapshot stored on the draft when it was assigned, not the customer's current address. It is `null` when the draft has no snapshot.

After a page reload, the POS can show each draft's customer from `GET /sales/drafts` alone. No extra calls are needed.

## Queries

The query count does not grow with the number of drafts. The customer is loaded through the same `findMany` as the rest of the draft. The PostgreSQL integration spec measured 8 SQL statements per request for 1 draft and also 8 for 6 drafts.

## Risks and limits

- **Response size.** A user can have any number of drafts. There is no cap and no pagination (unchanged). Drafts are not deleted automatically. Each row already carries all of its items. The new keys add about 0.3–0.5 KB per row at most, which is small next to the items. If one user ever has hundreds of open drafts, the response grows with them, as it does today.
- **Permissions.** No new data is exposed. `read:Sale` already returns the same customer fields `{ id, firstName, lastName }` in `GET /sales` and `GET /sales/:id`. Those routes also return a larger shipping address view than this summary. The draft list only shows the caller's own drafts. Customer phone, email, RFC and billing data, and the address visual references, carrier phone, label and coordinates, are **not** in the row.
