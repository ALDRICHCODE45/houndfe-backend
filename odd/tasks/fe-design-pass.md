# FE design-pass requests (cash fields, unreadable editorial, demo passwords)
Branch `feat/fe-design-pass` (worktree `.tmp/fe-design-pass`). Requests from the FE design pass (FE main 51c8fb3a); owner approved 2026-11-06.

## Specs
- S1 GET /cash-sessions items gain additive `openedAt`, `closedAt`, `cashierDisplayName` ("Hoy dos filas «Caja Mostrador 2 · Cerrada · $1,000.00» no se distinguen").
- S2 GET /cash-sessions/:id gains the cashier's visible name (the card says «Otra persona»).
- S3 GET /cash-handovers/custody items gain `senderDisplayName`, `sourceRegisterName` (today only an id and only for floats) and the sender's `notes`.
- S4 GET /products/:id/editorial for a product whose stored editorial state is not V2 (legacy) returns a typed `409 EDITORIAL_STATE_UNREADABLE` instead of 500 INTERNAL_ERROR ("409 claro + reparar"); other editorial endpoints that decode the same state behave consistently; docs updated (the current docs say legacy slots reject as INTERNAL_ERROR).
- S5 Repair the 4 seeded products with legacy editorial documents (Ruffwear Front Range, Kong 1.8 m, Flexi New Classic, Diamond Naturals 13.6 kg) in the dev seed/showcase data so they can be edited (decide: reset their editorial state so the editor can initialize a V2 draft).
- S6 Showcase: `SHOWCASE_RESET_PASSWORDS=1` resets the demo password of the showcase users (repartidor@houndfe.com included); without the flag nothing changes.

## Tasks
| ID | Task | Specs | Route | Commit |
| --- | --- | --- | --- | --- |
| T1 | Additive cash session/custody fields | S1 S2 S3 | worker | 65b3299, 5b18062 |
| T2 | Typed 409 for unreadable editorial state + seed repair | S4 S5 | worker | |
| T3 | Showcase password reset flag | S6 | worker with T2 (scripts) | |

## Log
- L1 (FE design pass, relayed): «Campos que faltan (solo agregar, opcionales): 1. GET /cash-sessions (items): openedAt, closedAt, cashierDisplayName… 2. GET /cash-sessions/:id: el nombre visible del cajero… 3. GET /cash-handovers/custody (items): senderDisplayName, sourceRegisterName… y las notes del que entrega… 4. GET /products/:id/editorial responde 500 para cuatro productos del seed… Dato del seed: repartidor@houndfe.com… ¿El seed debería fijarle una contraseña conocida?»
- L2 (user): cash fields "Sí (recomendado)"; editorial "409 claro + reparar (recomendado)"; demo password "Sí, con un flag (recomendado)".
- L3 (explore): editorial decode throws TypeError in src/catalog-editorial/application/editorial-recorded-state-v2.ts:97-102 → EditorialHttpFilter maps to 500 (docs/catalog-editorial-single-contract.md:127-128 says intended). Cash: projection src/cash-register/domain/cash-session.policy.ts:135-195, queries infrastructure/cash-adapter-queries.ts:82-264, custody infrastructure/cash-adapter-custody-queries.ts:113-209; spec pinning custody keys cash-adapter-custody-queries.spec.ts:345-357. Showcase password only on create: scripts/dev-showcase/org.cjs:12,139-150.
- L4 (T1 done): keys openedAt/closedAt/cashierDisplayName on session list items and detail session; senderDisplayName/sourceRegisterName/notes on custody items (all kinds). Handoff 09. cash-proof integration spec (CASH_PROOF_DISPOSABLE=1, own DB) updated but not run.
