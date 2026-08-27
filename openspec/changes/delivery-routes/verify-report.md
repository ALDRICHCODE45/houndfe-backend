# Verify Report — `delivery-routes`

Status: verified (all three WUs implemented, tested, built green).

## Scope

Verification covers the full `delivery-routes` SDD change across its three
stacked work units:

- **WU1** — persistence & access seeds (Prisma models, migrations, tenant
  allowlist, RBAC seeds, `NotificationActionKey`).
- **WU2** — bounded context core, CASL/guard extension, `Sale` mirror.
- **WU3** — durable outbox/Inngest/email pipeline, read model timeline, tests,
  docs.

## Verification commands and results

| Command | Result |
|---|---|
| `pnpm build` (nest build) | exit 0 (green) |
| `pnpm prisma validate` | valid |
| `pnpm prisma generate` | client regenerated |
| `prisma migrate deploy` (test DB 5433) | all migrations applied, incl. partial unique index + `ALTER TYPE ... ADD VALUE 'DELIVERY_NEXT_STOP'` |
| `jest --config jest.config.js` (full unit suite) | **211 suites / 2929 tests passed** |
| `jest --config jest.integration.config.js --runInBand` (markSaleDelivered) | 4/4 passed |
| `jest --config jest.integration.config.js --runInBand` (prisma-delivery-route.repository) | 9/9 passed (ADR-7 P2002 → 409 verified against real Postgres) |

## Key behavioral verifications

- **ADR-7 invariant** — the partial unique index
  `delivery_route_stops_active_sale_uniq` exists on Postgres (verified via
  `pg_indexes`), and a real `P2002` maps to
  `DeliveryRouteSaleAlreadyInActiveRouteError` → HTTP 409 through
  `DomainExceptionFilter`.
- **Driver ownership (ADR-5)** — CASL subject-instance re-check in
  `PermissionsGuard` verified at runtime: string subjects short-circuit
  condition matching, tagged-instance re-check evaluates `{ driverUserId }`.
  Own route passes, other driver's route 403.
- **`Sale.markDelivered`** — idempotent, status-only mirror, cross-tenant is a
  hard `P2025` (no mutation).
- **Email pipeline** — outbox row written inside `checkInStop` transaction;
  Inngest function re-gates on `DELIVERY_NEXT_STOP` config + authoritative
  email lookup, null-skip, `MAILER` send.

## Known deviations reconciled in sync

See `sync-report.md` for the seven drift areas (single-layer 409 enforcement,
`start` not re-validating eligibility, outbox payload field shape, etc.). All
were reconciled into the canonical spec; none are defects.

## Conclusion

All acceptance criteria and verification gates pass. The change is ready for
archive.
