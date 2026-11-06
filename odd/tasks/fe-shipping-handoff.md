# FE handoff for shipping settings screens + showcase data
Branch `docs/fe-shipping-handoff` (worktree `.tmp/fe-shipping-handoff`). Requested by the FE design pass 2026-11-06.

## Specs
- S1 One FE handoff doc (docs/frontend-handoff/10-shipping-settings-screens.md + README row) covering, per screen — delivery zones, pending zone validations, product/variant packaging, standard boxes, shipping origin, opening hours: "endpoints con request/response exactos y errores (code + status), permisos CASL que aplican, qué edita quién, reglas de validación con ejemplos, si hay datos seed legibles para probar en :3003, y qué está en tu main local vs pendiente". Every shape taken from the code (controllers, DTOs, filters) and checked against real responses.
- S2 Readable seed data for those screens in Sucursal Centro on the dev DB, through the dev showcase (idempotent): a few delivery zones of each type, at least one pending zone validation with requesters (urgency visible), two standard boxes, the shipping origin, opening hours, and packaging on a handful of products/variants; documented in the README showcase section and in the handoff.

## Tasks
| ID | Task | Specs | Route | Commit |
| --- | --- | --- | --- | --- |
| T1 | Showcase shipping data step + handoff 10 | S1 S2 | worker | |

## Log
- L1 (FE): «sí, armá el handoff de zonas, empaque, cajas, origen y horario, que lo implementamos. Para que pueda planificar sin ida y vuelta, incluí por pantalla: endpoints con request/response exactos y errores (code + status), permisos CASL que aplican, qué edita quién, reglas de validación con ejemplos, si hay datos seed legibles para probar en :3003, y qué está en tu main local vs pendiente. Avisame la ruta del doc y el SHA cuando esté.»
