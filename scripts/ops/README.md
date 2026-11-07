# Ops scripts

One-off operator scripts that run against the **compiled** app (`dist/`). Run
them from the app root (the directory holding `dist/`, `node_modules/` and
`prisma/`; `/app` inside the production container). Each one prints the
database target as `host:port/db` (never credentials) before doing anything.

## load-test-products.cjs

Creates six `[PRUEBA] ` pet products in one tenant through the application
services (`ProductsService.create`, `ProductPackagingService.putProduct`) with
the CLS context the HTTP guards would set, checked against the actor's CASL
permissions. Each product: type `PRODUCT`, default price-list price, 50 units of
`INITIAL` stock in the inventory journal, packaging, `includeInOnlineCatalog`.
That is enough for `GET /chatbot-api/catalog/search` and
`POST /chatbot-api/shipping/quotes`.

```sh
# dry run: reads only, prints the plan, does not boot Nest
node scripts/ops/load-test-products.cjs --tenant <slug> --actor-email <email>
# write
node scripts/ops/load-test-products.cjs --tenant <slug> --actor-email <email> --apply
```

| Flag                    | Effect                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `--tenant <slug>`       | Required. Active tenant.                                                                                                    |
| `--actor-email <email>` | Required. Active user with a membership in the tenant; needs create/update (and delete for deletions) on `Product`.         |
| `--apply`               | Write. Without it nothing is written.                                                                                       |
| `--delete-demo`         | Also delete the `prisma/seed.ts` demo products `Paracetamol 500mg` and `Ibuprofeno 400mg`, only if they have no sale items. |
| `--delete-test`         | Delete the six test products (if unsold) instead of loading them.                                                           |

- Idempotent: a product that already exists by name in the tenant is skipped;
  only its packaging is restored if missing.
- Deletion goes through `ProductsService.remove`, so the stock leaves through
  `REMOVAL` journal movements that outlive the product rows.
- Exits non-zero with `FAILED <code>: <message>` on any error.
- Needs `DATABASE_URL` plus the env the API itself validates at boot
  (`NODE_ENV`, JWT keys, …) for `--apply`. Without `DATABASE_URL` it loads
  `./.env` if present (dev convenience).
- `--apply` boots the full `AppModule`. That runs the permission seeder
  (idempotent upserts, same as an API start), and the script then stops the
  outbox pollers so they don't compete with the running API.
