<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ pnpm install
```

## Compile and run the project

```bash
# development
$ pnpm run start

# watch mode
$ pnpm run start:dev

# production mode
$ pnpm run start:prod
```

## Run tests

```bash
# unit tests
$ pnpm run test

# e2e tests
$ pnpm run test:e2e

# test coverage
$ pnpm run test:cov
```

## Demo data (dev showcase)

Varied, readable demo data so every screen of the frontend shows its main cases. It is for local/dev databases only.

```bash
pnpm prisma migrate deploy   # migrated database
pnpm seed                    # base seed: tenants, users, products, employees
pnpm build                   # the showcase drives the real API from dist/
pnpm seed:showcase           # demo data; safe to run again
```

How it works:

- `scripts/dev-showcase/seed.cjs` starts the built API on a free local port and runs the modules in order: `org` → `catalog` → `commerce` → `ops` → `shipping`. It stops the API when it ends (log: `.showcase-app.log`).
- Stateful flows (stock, sales, cancellations, purchase orders, routes, time off) go through the real endpoints, so the inventory kardex stays consistent. Prisma is used only where no endpoint exists (for example backdating sales across the month).
- It is idempotent: running it again creates nothing new. Dates are relative to today, so a later run moves the demo forward in time.
- It refuses to run with `NODE_ENV=production` or against a database host that is not local. Set `SHOWCASE_ALLOW=1` only for a disposable remote database.
- Before seeding it removes leftovers of earlier runtime probes («Prueba T8 …», «zz sale probe», the price list «Online (dev)» and the route «Lleva cambio por fvor.»).

### Demo users

Passwords are not repeated here. Base-seed users use the passwords in `prisma/seed.ts`. Users created by the showcase use `SHOWCASE_DEMO_PASSWORD`, or the default in `scripts/dev-showcase/org.cjs`. In development the login skips the email OTP.

An existing showcase user keeps their password. To set the demo password again for the four showcase users below (`repartidor@houndfe.com`, `vendedor@houndfe.com`, `gerente.norte@houndfe.com`, `cajero.norte@houndfe.com`), run with the flag. The run lists the emails it reset, never the password. Base-seed users (`admin`, `manager`, `cashier`) are not touched.

```bash
SHOWCASE_RESET_PASSWORDS=1 pnpm seed:showcase
```

| Email | Name | Sucursal | Role | Use it to see |
| --- | --- | --- | --- | --- |
| `admin@houndfe.com` | Super Admin | all | Super Admin | Everything; switch between sucursales |
| `manager@houndfe.com` | — | Sucursal Centro | Manager (Gerente) | Inventory, purchases, routes, quotations, promotions, cash supervision |
| `cashier@houndfe.com` | — | Sucursal Centro | Cashier (Cajero) | POS sales, cash sessions and handovers |
| `repartidor@houndfe.com` | Luis Hernández | Sucursal Centro | repartidor | Delivery routes |
| `vendedor@houndfe.com` | Sofía Ramírez | Sucursal Centro | Vendedor | Read-only catalog and sales, **no inventory permissions** (403 screens) |
| `gerente.norte@houndfe.com` | Andrea Torres | Sucursal Norte | Manager | A second sucursal |
| `cajero.norte@houndfe.com` | Valeria Núñez | Sucursal Norte | Cashier | A second sucursal |

Sucursal Sur has a single member (the super admin). The showcase adds demo permissions to the Centro roles; it only adds grants, never removes them.

### What each module creates (Sucursal Centro)

| Module | Screens and cases |
| --- | --- |
| `org` | Sucursales Centro, Norte and Sur with address and phone; Spanish role descriptions; the users above. |
| `catalog` | 38 products: high, low and zero stock; lots expired, expiring in under 7 days and valid; variants with one at 0; no stock control; services; with and without image; a 98-character name; 8 categories, many brands, 4 price lists. A kardex product («Alimento Premium para Perro Adulto 15 kg») with 30+ movements: opening, initial stock, every adjustment reason, a FEFO sale split across two lots and its cancellation. A variant removal on «Collar Ajustable de Nailon». Public catalog with «Disponible», «Pocas piezas» and «Agotado». |
| `commerce` | 20 customers (several addresses, outstanding balances, a very long name, a business with billing data); ~57 sales over the last 28 days (paid by cash, card, transfer and mixed; credit, partial, overdue; cancelled with pending and partly settled refunds; delivered and pending delivery; «Público en general»); 9 quotations (draft, sent, expired, cancelled, no expiry, with promotion); 12 promotions (each type active, scheduled and ended; one nearly exhausted, unlimited ones); 5 cash registers (2 inactive), an open session, closed sessions (one with a shortfall) and a pending custody handover. |
| `ops` | Human decisions pending and resolved (positive and negative); delivery routes draft, active today (delivered, skipped, current and pending stops), completed and cancelled; 5 suppliers (one archived) and 11 purchase orders with 0, 1, 2 and 4 checklist warnings, confirmed and cancelled; employee documents expired and expiring; time off pending (single and multi-day), approved and rejected; payment methods and bank accounts with one inactive each; notification settings with modules on and off; a published catalog with public price lists. |
| `shipping` | Shipping settings screens (see [handoff 10](docs/frontend-handoff/10-shipping-settings-screens.md#8-seed-data-on-3003)): delivery zones of every type in CDMX (FREE 03100/03020/03810, SURCHARGE 06700/04000, CARRIER_ONLY 16000/14000, DENIED 12000, 03300 deactivated, 11000 approved through a resolved validation); PENDING zone validations 03900 (CRITICAL), 06600 (WARNING, 2 requesters) and 04510 (OK); boxes «Caja chica» and «Caja mediana»; the shipping origin (Av. Insurgentes Sur 1458, 03100); opening hours Mon–Fri 09:00–14:00 and 16:00–19:30, Sat 09:00–14:00, Sun closed; packaging on 5 products plus a «Grande» override on «Arnés Acolchado para Paseo». Adds the `DeliveryZone` and `ShippingSettings` grants of `prisma/seed.ts` to the Centro and Norte `Manager` roles. |

### Repairing legacy editorial documents

Four Sucursal Centro products have editorial documents saved before editorial V2: «Collar ajustable Ruffwear Front Range», «Correa de nylon reforzada Kong 1.8 m», «Correa retráctil Flexi New Classic» and «Croqueta Diamond Naturals Cordero y Arroz 13.6 kg». The editor cannot open them (`409 EDITORIAL_STATE_UNREADABLE`). These rows exist only in the dev database. They came from the old dev catalog seed on the unmerged `chore/dev-catalog-seed` branch. No script on `main` writes editorial state.

```bash
pnpm build                                          # the repair uses the API's V2 decoder from dist/
node scripts/dev-showcase/editorial-repair.cjs          # dry run: counts only
node scripts/dev-showcase/editorial-repair.cjs --apply  # repair
```

- It only looks at those four products in Sucursal Centro. It has the same local-database guard as the showcase.
- It clears only the Draft or Published slots that do not decode as V2. Valid slots stay. A cleared Published records its revision as unpublished, so revision numbers never repeat.
- A row is deleted only when nothing valid is left and no editorial receipt references it. Receipts are never deleted. A referenced row stays with empty slots.
- It prints `rowsMatched`, `slotsCleared`, `rowsDeleted`, `rowsKeptReferenced` and the product names, never document contents. A second run finds nothing to do.
- Afterwards the editor reads the product with no draft and can start a new V2 draft.

### Shipping requesters and urgency

There is no staff endpoint that opens a zone validation; the bot intake does. The `shipping` module therefore inserts the bot requesters with Prisma exactly as the intake adapter does (same advisory lock, columns and request hash), but never writes the notification outbox row, so seeding sends no email. Everything else (zones, the resolve, boxes, origin, hours, packaging) goes through the real endpoints as `manager@houndfe.com`.

Urgency counts from each requester's last message, so it changes over time. A run on a later day moves the last message of every PENDING showcase validation back to its planned offset (CRITICAL 21 h ago, WARNING 15 h and 3 h ago, OK 2 h ago) when its level no longer matches. A run while the levels still match changes nothing. Zones, boxes, origin, hours and packaging are created only when missing: FE edits are kept. A showcase validation that someone resolved stays resolved.

Cases the domain does not support are not faked: a «vencida» human decision, a route without driver or stops, a «convertida» quotation, and an inactive product flag (shown instead as hidden from POS and the online catalog). Product images are `placehold.co` URLs and need internet access.

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ pnpm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
