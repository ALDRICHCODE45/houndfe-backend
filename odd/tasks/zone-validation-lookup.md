# Find the pending validation of a postal code
Branch `feat/zone-validation-lookup` (worktree `.tmp/zone-lookup`). Requested by the FE 2026-11-06 (non-blocking).

## Specs
- S1 GET /delivery-zone-validations accepts an optional `?zipCode=NNNNN` (exactly 5 digits, else 400 like the existing query validation) that filters the list to that postal code; without it the list is unchanged.
- S2 The 409 DELIVERY_ZONE_VALIDATION_PENDING returned by PUT/DELETE /delivery-zones/:zipCode gains an additive `validationId` (the PENDING validation of that postal code) in the same error envelope it uses today; nothing else in the body changes.

## Tasks
| ID | Task | Specs | Route | Commit |
| --- | --- | --- | --- | --- |
| T1 | zipCode filter + validationId on the 409 + docs | S1 S2 | worker | fd4fc8c, 2e944a5 |

## Log
- L1 (FE): «GET /delivery-zone-validations no se puede filtrar por código postal. Cuando un PUT /delivery-zones/:zipCode devuelve 409 DELIVERY_ZONE_VALIDATION_PENDING, el doc dice que lleve al usuario a esa validación, pero no tengo cómo encontrarla sin recorrer las páginas. ¿Podés agregar un ?zipCode=NNNNN al listado, o el id de la validación en el body del 409?»
- L2 (parent): do both (additive).
- L3 (T1 done): validationId only on PUT 409 (DELETE has no PENDING check, unchanged). Test-support world now uses the production validation pipe.
