# houndfe-backend Project Context

## Initialization

- **Feature:** `custom-payment-methods`
- **Repository:** `houndfe-backend`
- **Artifact store:** OpenSpec
- **Initialization scope:** project and SDD context only
- **Feature requirements and architecture:** intentionally not decided in this phase

## Project profile

- NestJS 11 application written in TypeScript 5.7.
- Prisma 6.19.2 client and CLI with PostgreSQL persistence.
- Hexagonal / domain-driven bounded contexts under `src/<context>`.
- Multi-tenant context established by Nest CLS and `TenantPrismaService`.
- Domain objects use factories and persistence reconstruction, commonly `static create(...)` and `static fromPersistence(...)`.
- Persistence access is expressed through repository interfaces and symbols, with Prisma adapters under `infrastructure/`.
- Reliability-sensitive writes use `TenantPrismaService.runInTransaction(...)`; outbox events are used where asynchronous side effects must remain durable.
- HTTP endpoints commonly use JWT authentication, `TenantContextGuard`, CASL `PermissionsGuard`, and `@RequirePermissions(...)`.
- DTOs use `class-validator`; bootstrap enables `whitelist`, `forbidNonWhitelisted`, and `transform`.
- Domain and Prisma exceptions are mapped to stable HTTP response codes through global filters.

## OpenSpec configuration

`openspec/config.yaml` exists and is usable. It was read without modification.

- **Schema:** `spec-driven`
- **Proposal rule:** include a rollback plan for risky changes.
- **Specification rules:** use RFC 2119 keywords and Given/When/Then scenarios.
- **Design rules:** include sequence diagrams for complex flows and document architectural decisions with rationale.
- **Task rules:** group by phase, use hierarchical numbering, and keep tasks completable in one session.
- **Apply TDD:** disabled (`tdd: false`).
- **Apply test command:** `pnpm test`.
- **Verify test command:** `pnpm test`.
- **Verify build command:** `pnpm build`.
- **Verify coverage threshold:** `0`.
- **Archive rule:** warn before merging destructive deltas.

The configured testing description is older than the current repository state: OpenSpec says there is no E2E infrastructure, while the repository now contains a dedicated PostgreSQL-backed Jest integration configuration at `jest.integration.config.js`. This is a documentation drift only; the configured unit test and build commands both pass.

## Testing baseline

The following checks were run during initialization:

- `pnpm test`: passed; 199 suites and 2,735 tests passed.
- `pnpm build`: passed.

The unit Jest configuration:

- Searches `src` and `prisma`.
- Uses `ts-jest` and the Node test environment.
- Treats co-located `*.spec.ts` files as unit tests.
- Excludes `*.integration.spec.ts` and the explicitly documented database-backed exceptions, so `pnpm test` does not require PostgreSQL.
- Includes focused ESM handling for React PDF and React Email dependencies.

The integration configuration:

- Is defined in `jest.integration.config.js`.
- Loads `.env.test` before Prisma construction.
- Runs `prisma migrate deploy` and baseline database setup in global setup.
- Runs in band for deterministic database behavior.
- Uses Jest command `pnpm test:integration`.

Coverage is enabled through `pnpm test:cov`, but the configured verification threshold is zero and there is no SDD-enforced coverage gate.

## Payment-related baseline

The current implementation distinguishes payment method configuration from sale payment records:

- `SalePaymentMethod` is a Prisma enum containing `CASH`, `CARD_CREDIT`, `CARD_DEBIT`, `TRANSFER`, and `CREDIT`.
- `SalePayment.method` and `SaleRefund.method` use that enum.
- `AddSalePaymentDto` accepts `cash`, `card_credit`, `card_debit`, or `transfer`; service validation rejects unsupported values.
- The sale flow supports legacy single-payment and batch-payment payloads, idempotency, payment updates, sale confirmation, cancellation refunds, outbox events, response/timeline shapes, and PDF presentation.
- `Customer.preferredPaymentMethod` is currently stored as an unconstrained nullable string.
- `PaymentDetail` is a separate tenant-scoped bounded context for bank transfer instructions, not a catalog of sale payment methods. It already demonstrates the current entity/repository/service/controller pattern and CASL registry conventions.

Any exploration of custom payment methods must therefore account for persistence compatibility, sale and refund behavior, reporting, idempotency, bot and customer integrations, and distinction from `PaymentDetail`. These are baseline considerations, not approved design decisions.

## Repository conventions to preserve

- Place new bounded-context code under `src/custom-payment-methods/` or the context name selected during proposal, with clear domain, application, infrastructure, DTO, and presentation boundaries.
- Keep domain entities free of Nest and Prisma dependencies.
- Co-locate Jest unit specs with source files; name database tests `*.integration.spec.ts` and keep mocked repository tests in the unit suite.
- Add the new model to the tenant-scoped model allowlist so `TenantPrismaService` enforces tenant filters and tenant attribution.
- Use explicit tenant filters as defense in depth where repository contracts make them visible.
- Keep authorization type-safe through `AppSubjects` and `PERMISSION_REGISTRY`; permissions are seeded at application bootstrap.
- Preserve existing money representation in integer cents and treat money values as trusted during validation.
- Use RFC 2119 requirements and Given/When/Then acceptance scenarios in the eventual specification.
- Keep migration, Prisma client generation, unit tests, build, and any relevant database integration verification in task scope.

## Phase state

- No active OpenSpec change existed at initialization time.
- `openspec/changes/custom-payment-methods/` was not created.
- The next phase is exploration/proposal for change `custom-payment-methods`.
- The skill registry exists at `.atl/skill-registry.md`; no phase-specific skill path was injected for this initialization task.

## Key inspection sources

- `openspec/config.yaml`
- `package.json`
- `jest.config.js`
- `jest.integration.config.js`
- `tsconfig.json`
- `eslint.config.mjs`
- `src/app.module.ts`
- `src/main.ts`
- `src/shared/prisma/tenant-prisma.service.ts`
- `src/shared/prisma/tenant-prisma.factory.ts`
- `src/shared/tenant/tenant-scoped-models.constant.ts`
- `src/sales/sales-payments.controller.ts`
- `src/sales/dto/add-sale-payment.dto.ts`
- `src/sales/sales.service.ts`
- `src/admin/payment-details/`
- `prisma/schema.prisma`
