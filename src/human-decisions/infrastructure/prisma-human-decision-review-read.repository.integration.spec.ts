/**
 * HD-04b3b — PrismaHumanDecisionReviewReadRepository real-PostgreSQL
 * integration spec.
 *
 * HD-04b3a shipped the tenant-scoped reviewer READ adapter with a DB-free
 * companion spec (`prisma-human-decision-review-read.repository.spec.ts`) that
 * mocks `TenantPrismaService`. That spec proves the adapter SEAMS (pinned
 * predicate, SELECT allowlist, argument guards) but cannot prove what only
 * PostgreSQL can answer: real `ILIKE` case-folding, real LIKE-wildcard
 * escaping, real `tenantId` WHERE-injection from the tenant-scoping extension,
 * real ordering/tiebreak over committed rows, and the real CHECK-constrained
 * resolution state.
 *
 * This spec closes that gap against the dedicated isolated RESTOCK database
 * (`127.0.0.1:5433/nest-practice-restock-test`) with REAL Prisma and the REAL
 * `TenantPrismaService`. Exactly one thing is not real, and it is stated
 * plainly:
 *
 *   The CLS store is a per-harness `Map` shim, NOT the nestjs-cls
 *   AsyncLocalStorage. Each harness owns its own store, so two harnesses model
 *   two independent request contexts sharing one PostgreSQL pool. Actual ALS
 *   multiplexing and per-request isolation are NOT exercised here; they belong
 *   to the HD-03b3 HTTP spec, which boots the real `ClsModule` with a mounted
 *   middleware. This spec deliberately does NOT boot Nest, the full
 *   `AppModule`, the bot, any provider or any live service, and it issues no
 *   HTTP request.
 *
 * TENANT-EXTENSION PROOF SEPARATION: an adapter list assertion alone cannot
 * isolate the tenant-scoping extension's WHERE-injection, because the adapter
 * ALSO passes `tenantId` explicitly. One dedicated test therefore bypasses the
 * adapter and reads the tenant-scoped client returned by
 * `TenantPrismaService.getClient()` with an EMPTY `where`, per tenant, proving
 * the extension ALONE returns only that tenant's rows (while the root client
 * confirms both rows exist). The superadmin / no-tenant session test is its
 * counterpart: it shows the extension's bypass is real for that session shape,
 * so the adapter's unconditional `getTenantId()` is the actual fail-closed gate.
 *
 * ISOLATED-DB GUARD: same shape and intent as the HD-03b3 guard. Before this
 * file touches a row it validates BOTH the `.env.test` file parsed with the
 * local `dotenv` AND the ACTIVE `process.env.DATABASE_URL` that
 * `resetAndSeedBaseline` and the `TenantPrismaService` client actually connect
 * with, aborting unless each resolves to exactly
 * `postgresql://127.0.0.1:5433/nest-practice-restock-test`. The check runs at
 * module load (before any fixture or reset) and again before EVERY
 * `resetAndSeedBaseline()`, which truncates `tenants`/`users` CASCADE and is
 * therefore authorized exclusively for this dedicated database. Mismatch
 * errors are generic and redacted: the raw URL, its credentials and any
 * non-target database name are never echoed.
 *
 * CRITICAL: the integration Jest config runs `globalSetup` — which executes
 * `prisma migrate deploy` — BEFORE this spec module is evaluated. The in-spec
 * guard therefore CANNOT protect the migration step, and this suite must never
 * be the only destination check: every invocation requires the separate
 * pre-Jest destination precheck. (See the HD-04b3b task record for the exact
 * precheck command.)
 *
 * Scope boundary: this spec proves the read model against real PostgreSQL. It
 * makes NO claim about HTTP routing, auth, ALS request isolation, provider
 * delivery, resolution writes or the full application graph.
 *
 * Skip guard: `SKIP_DB_INTEGRATION=1` or an unset `DATABASE_URL` skips the
 * whole suite, matching the other integration specs.
 */
import { HumanDecisionType } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import * as dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ClsService } from 'nestjs-cls';
import {
  disconnectIntegrationPrisma,
  integrationPrisma,
  resetAndSeedBaseline,
} from '../../../test/integration/reset-db';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import {
  RESTOCK_SOURCE,
  RESTOCK_TYPE,
} from '../domain/restock-request-canonicalizer';
import type { HumanDecisionReviewRecord } from '../domain/human-decision-review-read.repository';
import { toHumanDecisionReviewResponse } from '../presentation/dto/human-decision-review.response';
import { PrismaHumanDecisionReviewReadRepository } from './prisma-human-decision-review-read.repository';

// ---------------------------------------------------------------------------
// Isolated test-DB target guard
// ---------------------------------------------------------------------------

const ENV_TEST_PATH = path.resolve(process.cwd(), '.env.test');
const EXPECTED_PROTOCOL = 'postgresql:';
const EXPECTED_HOSTNAME = '127.0.0.1';
const EXPECTED_PORT = '5433';
const EXPECTED_DATABASE = 'nest-practice-restock-test';

let targetLoggedOnce = false;

type DatabaseUrlSource = 'file' | 'active';

const SOURCE_LABELS: Record<DatabaseUrlSource, string> = {
  file: '.env.test',
  active: 'active process.env',
};

/**
 * Fail closed unless `rawUrl` resolves to the exact dedicated isolated RESTOCK
 * database. The error is intentionally generic and redacted: it never echoes
 * the raw URL or any of its components (credentials or a non-target database
 * name could be sensitive), only which endpoint was inspected.
 */
function assertMatchesIsolatedTarget(
  rawUrl: string | undefined,
  source: DatabaseUrlSource,
): void {
  if (!rawUrl) {
    throw new Error(
      `[hd-04b3b] refusing isolated-DB run: ${SOURCE_LABELS[source]} DATABASE_URL is unset.`,
    );
  }

  let url: globalThis.URL;
  try {
    url = new globalThis.URL(rawUrl);
  } catch {
    throw new Error(
      `[hd-04b3b] refusing isolated-DB run: ${SOURCE_LABELS[source]} DATABASE_URL is not a valid URL.`,
    );
  }

  let databaseName = url.pathname.replace(/^\//, '');
  try {
    databaseName = decodeURIComponent(databaseName);
  } catch {
    // Keep the encoded segment when it cannot be decoded.
  }

  const matches =
    url.protocol === EXPECTED_PROTOCOL &&
    url.hostname === EXPECTED_HOSTNAME &&
    url.port === EXPECTED_PORT &&
    databaseName === EXPECTED_DATABASE;

  if (!matches) {
    throw new Error(
      `[hd-04b3b] refusing isolated-DB run: ${SOURCE_LABELS[source]} DATABASE_URL does not match the dedicated isolated RESTOCK target.`,
    );
  }
}

/**
 * Validate BOTH database endpoints this suite depends on: the `.env.test` file
 * parsed with the local `dotenv` (authoritative for the Jest globalSetup
 * migration) AND the ACTIVE `process.env.DATABASE_URL`, which is what
 * `resetAndSeedBaseline` and the `TenantPrismaService` client actually connect
 * with. They can diverge (a stale shell export, a partially-applied override),
 * so a file-only check is insufficient. Only the sanitized expected destination
 * is printed once; raw URLs, credentials and any non-target database name are
 * never echoed.
 */
function assertIsolatedTestDatabaseTarget(): void {
  const parsedEnv = dotenv.parse(fs.readFileSync(ENV_TEST_PATH, 'utf8'));
  assertMatchesIsolatedTarget(parsedEnv.DATABASE_URL, 'file');
  assertMatchesIsolatedTarget(process.env.DATABASE_URL, 'active');

  if (!targetLoggedOnce) {
    targetLoggedOnce = true;
    console.log(
      `[hd-04b3b] isolated DB target OK: ${EXPECTED_PROTOCOL}//${EXPECTED_HOSTNAME}:${EXPECTED_PORT}/${EXPECTED_DATABASE}`,
    );
  }
}

const SKIP_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;

const describeIfDb = SKIP_INTEGRATION ? describe.skip : describe;

if (!SKIP_INTEGRATION) {
  // Fail fast at module load, before any fixture or reset touches the DB.
  assertIsolatedTestDatabaseTarget();
}

/** Guarded baseline reset: the target is re-validated before every truncate. */
async function resetIsolatedBaseline(): Promise<void> {
  assertIsolatedTestDatabaseTarget();
  await resetAndSeedBaseline();
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface ReviewHarness {
  repo: PrismaHumanDecisionReviewReadRepository;
  tenantPrisma: TenantPrismaService;
}

/**
 * Real Prisma-backed `TenantPrismaService` plus a PER-HARNESS CLS `Map` shim.
 *
 * The shim is NOT nestjs-cls AsyncLocalStorage: it is an in-memory key/value
 * store created per harness, so two harnesses faithfully model two independent
 * request contexts while sharing one PostgreSQL pool. Everything below the CLS
 * boundary is real: the real tenant-scoping `$extends` factory, the real
 * `TenantPrismaService` and the real `HumanDecision` queries.
 *
 * `tenantId: null` with `isSuperAdmin: true` reproduces the exact session shape
 * for which the tenant extension's superadmin branch SKIPS the `tenantId`
 * WHERE-injection, which is why the adapter's unconditional `getTenantId()`
 * call is the fail-closed gate that matters.
 */
function makeHarness(
  tenantId: string | null,
  isSuperAdmin = false,
  clock?: () => Date,
): ReviewHarness {
  const store = new Map<string, unknown>();
  store.set('tenantId', tenantId);
  store.set('isSuperAdmin', isSuperAdmin);
  const cls = {
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => {
      store.set(key, value);
    },
  } as unknown as ClsService<TenantClsStore>;
  // Instance-level delegation onto a `PrismaService` prototype over the shared
  // integration client; no behavior mocked.
  const prisma = Object.assign(
    Object.create(PrismaService.prototype) as PrismaService,
    integrationPrisma(),
  );
  const tenantPrisma = new TenantPrismaService(prisma, cls);
  return {
    repo: new PrismaHumanDecisionReviewReadRepository(tenantPrisma, clock),
    tenantPrisma,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Every `HumanDecision` column the reviewer read model is ALLOWED to expose.
 * Asserted as an exact key set so adding a column to the adapter's SELECT
 * allowlist without widening the port fails here.
 */
const REVIEW_SELECT_KEYS = [
  'branchId',
  'branchName',
  'createdAt',
  'expirationText',
  'id',
  'observedStockAtRequest',
  'productId',
  'productName',
  'productUnit',
  'requestedQuantity',
  'resolutionAction',
  'resolvedAt',
  'resolvedByActorId',
  'resolvedByDisplayName',
  'restockDays',
  'sku',
  'status',
  'stockObservedAt',
  'type',
  'variantId',
  'variantName',
  'variantOption',
  'variantValue',
  'version',
];

/**
 * Authority / credential / bot-evidence / audit columns that must never reach a
 * reviewer record.
 *
 * The allowlist test seeds real values into a REPRESENTATIVE subset of these
 * columns (enumerated in its own comment) rather than into every one of them:
 * the STALE outcome CHECK forbids provider evidence, so several of them are
 * structurally required to stay NULL. The entries that are not seeded are still
 * asserted absent by KEY, and the exact SELECT keyset assertion excludes them
 * regardless of whether the persisted value would be NULL or not NULL — the
 * proof is the keyset, not the seeded value.
 */
const FORBIDDEN_RECORD_KEYS = [
  'tenantId',
  'source',
  'sourceRequestId',
  'canonicalRequestHash',
  'submittedCredentialId',
  'supersedesDecisionId',
  'resolutionRequestId',
  'resolvedById',
  'applicationOutcome',
  'applicationAttemptId',
  'applicationEvidenceHash',
  'applicationEvidenceCode',
  'providerMessageId',
  'providerAcceptedObservedAt',
  'applicationAttemptedAt',
  'ackReceivedAt',
  'updatedAt',
];

const CREDENTIAL_ID = 'cred-hd04b3b';
const REVIEWER_ACTOR_ID = 'reviewer-hd04b3b';
const REVIEWER_DISPLAY_NAME = 'Reviewer Hd04b3b';

/** Deterministic resolution instant for `RESOLVED` fixtures. */
const RESOLVED_AT = new Date('2026-09-30T12:00:00.000Z');

/** Base instant for the pagination fixture; the tie group shares it exactly. */
const PAGINATION_BASE = new Date('2026-10-01T00:00:00.000Z');
/** Number of rows sharing one `createdAt`, to force the `id` tiebreak. */
const PAGINATION_TIE_COUNT = 5;
/** Tenant A queue size; deliberately above the largest whitelisted page (20). */
const PAGINATION_TOTAL = 28;
/** Extra tenant B rows that must never be counted in tenant A's pages. */
const PAGINATION_OTHER_TENANT_TOTAL = 3;

/** One explicit tenant per test; the baseline tenant is never reused. */
async function seedTenant(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await integrationPrisma().tenant.create({
    data: { id, name, slug: `hd04b3b-${id}` },
  });
  return id;
}

/**
 * Valid PENDING fixture: status/version defaults plus the immutable intake
 * snapshot. `productId`/`variantId` are canonical RFC 4122 UUIDs so the pure
 * reviewer mapper accepts the persisted row without normalizing anything.
 */
function pendingDecisionData(
  tenantId: string,
  overrides: Partial<Prisma.HumanDecisionUncheckedCreateInput> = {},
): Prisma.HumanDecisionUncheckedCreateInput {
  return {
    tenantId,
    source: RESTOCK_SOURCE,
    sourceRequestId: crypto.randomUUID(),
    type: RESTOCK_TYPE,
    canonicalRequestHash: `hash-${crypto.randomUUID()}`,
    submittedCredentialId: CREDENTIAL_ID,
    branchId: tenantId,
    branchName: 'Sucursal Centro',
    productId: crypto.randomUUID(),
    productName: 'Cafe de altura',
    variantId: null,
    sku: 'SKU-1',
    requestedQuantity: 5,
    observedStockAtRequest: null,
    stockObservedAt: null,
    status: 'PENDING',
    version: 1,
    ...overrides,
  };
}

/**
 * Valid `RESOLVED` fixture satisfying the HD-01 SQL CHECKs: `version = 2`, a
 * non-null resolution action, `resolutionRequestId`, `resolvedAt` and BOTH
 * immutable reviewer snapshots. The default action carries `restockDays`; the
 * negative action must omit it (see the mapper test).
 */
function resolvedDecisionData(
  tenantId: string,
  overrides: Partial<Prisma.HumanDecisionUncheckedCreateInput> = {},
): Prisma.HumanDecisionUncheckedCreateInput {
  return {
    ...pendingDecisionData(tenantId),
    status: 'RESOLVED',
    version: 2,
    resolutionAction: 'PROVIDE_RESTOCK_ESTIMATE',
    restockDays: 3,
    resolutionRequestId: crypto.randomUUID(),
    resolvedAt: RESOLVED_AT,
    resolvedByActorId: REVIEWER_ACTOR_ID,
    resolvedByDisplayName: REVIEWER_DISPLAY_NAME,
    ...overrides,
  };
}

/** Persist one fixture and return its id. */
async function seedDecision(
  data: Prisma.HumanDecisionUncheckedCreateInput,
): Promise<string> {
  const row = await integrationPrisma().humanDecision.create({ data });
  return row.id;
}

/** Counts every committed `HumanDecision` row regardless of tenant. */
async function totalDecisionRows(): Promise<number> {
  return integrationPrisma().humanDecision.count();
}

/**
 * Read a detail expected to resolve. Throws a fixed message instead of
 * returning a nullable record, so the spec never needs a non-null assertion.
 */
async function readDetail(
  repo: PrismaHumanDecisionReviewReadRepository,
  id: string,
): Promise<HumanDecisionReviewRecord> {
  const record = await repo.findById(id);
  if (record === null) {
    throw new Error('[hd-04b3b] expected the detail read to resolve a record');
  }
  return record;
}

interface SearchFixture {
  caseRow: string;
  percentRow: string;
  underscoreRow: string;
  backslashRow: string;
}

/**
 * Seed the seven search rows. Four are the expected matches; three are decoys
 * that a PATTERN interpretation of the term would have matched instead:
 *
 *   - `100%` vs `100x` (the `%` wildcard),
 *   - `Cafe_` vs `CafeX`/`Cafe ` (the `_` wildcard),
 *   - `Cafe\Importado` vs `CafeImportado` (the `\` escape introducer, where
 *     `\I` would degrade to a literal `I`).
 */
async function seedSearchFixture(tenantId: string): Promise<SearchFixture> {
  const [caseRow, percentRow, underscoreRow, backslashRow] = await Promise.all([
    seedDecision(
      pendingDecisionData(tenantId, { productName: 'Cafe de Altura' }),
    ),
    seedDecision(
      pendingDecisionData(tenantId, { productName: 'Cafe 100% puro' }),
    ),
    seedDecision(
      pendingDecisionData(tenantId, { productName: 'Cafe_Especial' }),
    ),
    seedDecision(
      pendingDecisionData(tenantId, { productName: 'Cafe\\Importado' }),
    ),
  ]);
  await Promise.all([
    seedDecision(
      pendingDecisionData(tenantId, { productName: 'Cafe 100x puro' }),
    ),
    seedDecision(
      pendingDecisionData(tenantId, { productName: 'CafeXEspecial' }),
    ),
    seedDecision(
      pendingDecisionData(tenantId, { productName: 'CafeImportado' }),
    ),
  ]);
  return { caseRow, percentRow, underscoreRow, backslashRow };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeIfDb(
  'PrismaHumanDecisionReviewReadRepository (HD-04b3b PostgreSQL integration)',
  () => {
    beforeAll(async () => {
      // Force the singleton construction early so a misconfigured
      // DATABASE_URL throws here (loud) rather than in the first test.
      integrationPrisma();
      await resetIsolatedBaseline();
    });

    afterEach(async () => {
      // TRUNCATE … CASCADE + re-seed: robust against any mid-test failure, and
      // it leaves the dedicated test DB at the known baseline for the next
      // test (and any later spec in the same run).
      await resetIsolatedBaseline();
    });

    afterAll(async () => {
      await disconnectIntegrationPrisma();
    });

    describe('isolated-DB target guard (test-only regression)', () => {
      it('rejects a non-target ACTIVE DATABASE_URL with a redacted error before any reset', () => {
        const originalUrl = process.env.DATABASE_URL;
        // Dummy non-target; it is never connected to. Each component (userinfo,
        // port, database name) is distinctive so the test can prove nothing
        // from it is echoed back by the guard.
        const dummyUrl =
          'postgresql://leak_user:leak_secret@127.0.0.1:5432/prod-secret-db';
        try {
          process.env.DATABASE_URL = dummyUrl;

          // No Prisma client is constructed while the env is mismatched: the
          // guard must fail closed before any reset/query.
          expect(() => assertIsolatedTestDatabaseTarget()).toThrow(
            /refusing isolated-DB run/,
          );

          let message = '';
          try {
            assertIsolatedTestDatabaseTarget();
          } catch (error) {
            message = error instanceof Error ? error.message : String(error);
          }
          expect(message).toContain('[hd-04b3b]');
          expect(message).toContain('active process.env');
          expect(message).not.toContain('leak_user');
          expect(message).not.toContain('leak_secret');
          expect(message).not.toContain('prod-secret-db');
          expect(message).not.toContain('5432');
          expect(message).not.toContain(dummyUrl);
        } finally {
          process.env.DATABASE_URL = originalUrl;
        }
      });
    });

    describe('recent resolved window (execution requires separate DB authorization)', () => {
      it('includes exact endpoints, excludes outside instants and scopes by resolution time', async () => {
        const tenant = await seedTenant('Recent responses');
        const other = await seedTenant('Other responses');
        const now = RESOLVED_AT;
        const cutoff = new Date(now.getTime() - 604_800_000);
        const old = new Date(cutoff.getTime() - 1);
        const atNow = await seedDecision(
          resolvedDecisionData(tenant, { resolvedAt: now, createdAt: old }),
        );
        const atCutoff = await seedDecision(
          resolvedDecisionData(tenant, { resolvedAt: cutoff, createdAt: old }),
        );
        const oldId = await seedDecision(
          resolvedDecisionData(tenant, { resolvedAt: old, createdAt: now }),
        );
        await seedDecision(
          resolvedDecisionData(tenant, {
            resolvedAt: new Date(now.getTime() + 1),
          }),
        );
        await seedDecision(resolvedDecisionData(other, { resolvedAt: now }));
        await seedDecision(
          resolvedDecisionData(tenant, {
            source: 'foreign-source',
            resolvedAt: now,
          }),
        );
        await seedDecision(pendingDecisionData(tenant));
        const { repo } = makeHarness(tenant, false, () => now);
        const result = await repo.listResolved({ page: 1, limit: 20 });
        expect(result.items.map(({ id }) => id)).toEqual([atNow, atCutoff]);
        expect(result.totalCount).toBe(2);
        expect((await repo.findById(oldId))?.status).toBe('RESOLVED');
      });

      it('paginates tied resolved timestamps by id without overlapping pages', async () => {
        const tenant = await seedTenant('Tied responses');
        const ids: string[] = [];
        for (let i = 0; i < 21; i++) {
          ids.push(await seedDecision(resolvedDecisionData(tenant)));
        }
        ids.sort();
        const { repo } = makeHarness(tenant, false, () => RESOLVED_AT);
        const first = await repo.listResolved({ page: 1, limit: 20 });
        const second = await repo.listResolved({ page: 2, limit: 20 });
        expect(first.items.map(({ id }) => id)).toEqual(ids.slice(0, 20));
        expect(second.items.map(({ id }) => id)).toEqual(ids.slice(20));
        expect([
          first.totalCount,
          second.totalCount,
          first.pageCount,
          second.pageCount,
        ]).toEqual([21, 21, 2, 2]);
      });
    });

    it('globally pages searched mixed partitions with time bounds and tied timestamps', async () => {
      const tenant = await seedTenant('Mixed responses');
      const other = await seedTenant('Other mixed responses');
      const pendingIds: string[] = [];
      const resolvedIds: string[] = [];
      const productName = 'Cafe%_';
      for (let i = 0; i < 23; i++) {
        pendingIds.push(
          await seedDecision(
            pendingDecisionData(tenant, {
              productName,
              createdAt: RESOLVED_AT,
            }),
          ),
        );
        resolvedIds.push(
          await seedDecision(resolvedDecisionData(tenant, { productName })),
        );
      }
      pendingIds.sort();
      resolvedIds.sort();
      const cutoffId = await seedDecision(
        resolvedDecisionData(tenant, {
          productName,
          resolvedAt: new Date(RESOLVED_AT.getTime() - 604_800_000),
        }),
      );
      for (const resolvedAt of [
        new Date(RESOLVED_AT.getTime() - 604_800_001),
        new Date(RESOLVED_AT.getTime() + 1),
      ]) {
        await seedDecision(
          resolvedDecisionData(tenant, { productName, resolvedAt }),
        );
      }
      await seedDecision(resolvedDecisionData(other, { productName }));
      await seedDecision(pendingDecisionData(other, { productName }));
      await seedDecision(
        resolvedDecisionData(tenant, { productName, source: 'foreign-source' }),
      );
      await seedDecision(
        pendingDecisionData(tenant, { productName: 'CafeXX' }),
      );
      const { repo } = makeHarness(tenant, false, () => RESOLVED_AT);
      const expected = [...pendingIds, ...resolvedIds, cutoffId];
      for (const page of [1, 2, 3]) {
        const result = await repo.listAll({ page, limit: 20, search: '%_' });
        expect(result.items.map(({ id }) => id)).toEqual(
          expected.slice((page - 1) * 20, page * 20),
        );
        expect(result.totalCount).toBe(47);
        expect(result.pageCount).toBe(3);
      }
    });

    describe('tenant isolation through the real tenant extension', () => {
      it('lists only the calling tenant PENDING RESTOCK decisions', async () => {
        const tenantA = await seedTenant('Review Tenant A');
        const tenantB = await seedTenant('Review Tenant B');
        const a1 = await seedDecision(pendingDecisionData(tenantA));
        const a2 = await seedDecision(pendingDecisionData(tenantA));
        const b1 = await seedDecision(pendingDecisionData(tenantB));
        const b2 = await seedDecision(pendingDecisionData(tenantB));

        const pageA = await makeHarness(tenantA).repo.listPending({
          page: 1,
          limit: 20,
        });
        const pageB = await makeHarness(tenantB).repo.listPending({
          page: 1,
          limit: 20,
        });

        expect(pageA.items.map((item) => item.id).sort()).toEqual(
          [a1, a2].sort(),
        );
        expect(pageA.totalCount).toBe(2);
        expect(pageB.items.map((item) => item.id).sort()).toEqual(
          [b1, b2].sort(),
        );
        expect(pageB.totalCount).toBe(2);

        const sharedIds = pageA.items
          .map((item) => item.id)
          .filter((id) => pageB.items.some((item) => item.id === id));
        expect(sharedIds).toEqual([]);
        // Non-vacuous: all four rows really are committed in that one database.
        expect(await totalDecisionRows()).toBe(4);
      });

      it('injects the caller tenantId into a raw tenant-scoped client read, without the adapter predicate', async () => {
        const tenantA = await seedTenant('Extension Tenant A');
        const tenantB = await seedTenant('Extension Tenant B');
        const pendingA = await seedDecision(pendingDecisionData(tenantA));
        const pendingB = await seedDecision(pendingDecisionData(tenantB));

        // No adapter, no explicit tenantId: the ONLY thing scoping these two
        // reads is the tenant-scoping extension injected by
        // TenantPrismaService.getClient().
        const tenantARows = await makeHarness(tenantA)
          .tenantPrisma.getClient()
          .humanDecision.findMany({ where: {} });
        const tenantBRows = await makeHarness(tenantB)
          .tenantPrisma.getClient()
          .humanDecision.findMany({ where: {} });

        expect(tenantARows.map((row) => row.id)).toEqual([pendingA]);
        expect(tenantARows.map((row) => row.tenantId)).toEqual([tenantA]);
        expect(tenantBRows.map((row) => row.id)).toEqual([pendingB]);
        expect(tenantBRows.map((row) => row.tenantId)).toEqual([tenantB]);
        // Non-vacuous: the root client sees BOTH committed rows, so each scoped
        // read above really excluded a row that exists in that same database.
        expect(await totalDecisionRows()).toBe(2);
      });

      it('fails closed for a superadmin session with no tenant context, even though the extension bypass is real', async () => {
        const tenantA = await seedTenant('No Context Tenant A');
        const tenantB = await seedTenant('No Context Tenant B');
        const pendingA = await seedDecision(pendingDecisionData(tenantA));
        const pendingB = await seedDecision(pendingDecisionData(tenantB));
        const { repo, tenantPrisma } = makeHarness(null, true);

        await expect(repo.listPending({ page: 1, limit: 20 })).rejects.toThrow(
          'Tenant context required',
        );
        await expect(repo.findById(pendingA)).rejects.toThrow(
          'Tenant context required',
        );

        // The adapter's unconditional `getTenantId()` is what blocks the read.
        // The tenant-scoping extension itself DOES skip the WHERE-injection for
        // this exact session shape (superadmin + no tenant), so the very same
        // CLS store lets an unfiltered query return BOTH tenants.
        const unscoped = await tenantPrisma
          .getClient()
          .humanDecision.findMany({ where: {} });
        expect(unscoped.map((row) => row.id).sort()).toEqual(
          [pendingA, pendingB].sort(),
        );
      });

      it('resolves detail for the owning tenant and null for the same id from another tenant', async () => {
        const tenantA = await seedTenant('Detail Tenant A');
        const tenantB = await seedTenant('Detail Tenant B');
        const decisionId = await seedDecision(pendingDecisionData(tenantA));

        const ownDetail = await makeHarness(tenantA).repo.findById(decisionId);
        expect(ownDetail).toMatchObject({
          id: decisionId,
          status: 'PENDING',
          version: 1,
          type: RESTOCK_TYPE,
        });

        await expect(
          makeHarness(tenantB).repo.findById(decisionId),
        ).resolves.toBeNull();
        // Non-vacuous: the id IS persisted, so the null above is tenant scope,
        // not a missing row.
        await expect(
          integrationPrisma().humanDecision.findUnique({
            where: { id: decisionId },
          }),
        ).resolves.toMatchObject({ id: decisionId, tenantId: tenantA });
      });
    });

    describe('pinned source, type and status', () => {
      it('admits a same-source PENDING EXPIRATION row while still excluding a foreign-source RESTOCK row', async () => {
        const tenantId = await seedTenant('Source Scope Tenant');
        const inScope = await seedDecision(
          pendingDecisionData(tenantId, {
            createdAt: new Date('2026-09-01T00:00:00.000Z'),
          }),
        );
        const outOfScope = await seedDecision(
          pendingDecisionData(tenantId, {
            source: 'other-bot-source',
            createdAt: new Date('2026-09-01T00:01:00.000Z'),
          }),
        );
        // Admitted same-tenant/source PENDING EXPIRATION row with a valid unit
        // and variant fields and NULL RESTOCK-only columns. `source` is shared
        // (both 'houndfe-chatbot'), so the widened closed type set is the ONLY
        // reason it is now readable while the foreign SOURCE row stays excluded.
        const expirationId = await seedDecision(
          pendingDecisionData(tenantId, {
            type: HumanDecisionType.EXPIRATION,
            productUnit: 'UNIDAD',
            variantId: crypto.randomUUID(),
            variantName: 'Presentación A',
            variantOption: 'Peso',
            variantValue: '1 kg',
            sku: null,
            requestedQuantity: null,
            createdAt: new Date('2026-09-01T00:02:00.000Z'),
          }),
        );

        const { repo } = makeHarness(tenantId);
        const page = await repo.listPending({ page: 1, limit: 20 });

        expect(page.items.map((item) => item.id)).toEqual([
          inScope,
          expirationId,
        ]);
        expect(page.totalCount).toBe(2);
        expect(Object.keys(page.items[0]).sort()).toEqual(REVIEW_SELECT_KEYS);
        const expirationDetail = await readDetail(repo, expirationId);
        expect(Object.keys(expirationDetail).sort()).toEqual(
          REVIEW_SELECT_KEYS,
        );
        expect(expirationDetail).toMatchObject({
          type: HumanDecisionType.EXPIRATION,
          productUnit: 'UNIDAD',
          variantName: 'Presentación A',
          variantOption: 'Peso',
          variantValue: '1 kg',
        });
        await expect(repo.findById(outOfScope)).resolves.toBeNull();

        const persisted = await integrationPrisma().humanDecision.findUnique({
          where: { id: outOfScope },
        });
        expect(persisted).toMatchObject({
          id: outOfScope,
          tenantId,
          source: 'other-bot-source',
          type: RESTOCK_TYPE,
          status: 'PENDING',
        });
        const expRow = await integrationPrisma().humanDecision.findUnique({
          where: { id: expirationId },
        });
        expect(expRow).toMatchObject({
          type: HumanDecisionType.EXPIRATION,
          productUnit: 'UNIDAD',
          variantName: 'Presentación A',
        });
      });

      it('lists only PENDING while the same tenant still resolves both RESOLVED shapes', async () => {
        const tenantId = await seedTenant('Resolution Tenant');
        const pendingId = await seedDecision(pendingDecisionData(tenantId));
        const estimateId = await seedDecision(resolvedDecisionData(tenantId));
        const unavailableId = await seedDecision(
          resolvedDecisionData(tenantId, {
            resolutionAction: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
            restockDays: null,
          }),
        );

        const { repo } = makeHarness(tenantId);
        const page = await repo.listPending({ page: 1, limit: 20 });

        expect(page.items.map((item) => item.id)).toEqual([pendingId]);
        expect(page.totalCount).toBe(1);

        const estimate = await readDetail(repo, estimateId);
        expect(estimate).toMatchObject({
          id: estimateId,
          status: 'RESOLVED',
          version: 2,
          resolutionAction: 'PROVIDE_RESTOCK_ESTIMATE',
          restockDays: 3,
          resolvedByActorId: REVIEWER_ACTOR_ID,
          resolvedByDisplayName: REVIEWER_DISPLAY_NAME,
        });
        expect(estimate.resolvedAt?.toISOString()).toBe(
          RESOLVED_AT.toISOString(),
        );

        const unavailable = await readDetail(repo, unavailableId);
        expect(unavailable).toMatchObject({
          id: unavailableId,
          status: 'RESOLVED',
          version: 2,
          resolutionAction: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
          restockDays: null,
        });
        // Non-vacuous: both RESOLVED rows are committed (the SQL CHECK accepted
        // them), so PENDING-only is a list rule, not a row rule.
        await expect(
          integrationPrisma().humanDecision.count({ where: { tenantId } }),
        ).resolves.toBe(3);
      });
    });

    describe('stable ordering and pagination', () => {
      it('orders by createdAt then id across more than one page and reports the FE shape', async () => {
        const tenantA = await seedTenant('Pagination Tenant A');
        const tenantB = await seedTenant('Pagination Tenant B');

        const rows: Array<{ id: string; createdAt: Date }> = [];
        for (let index = 0; index < PAGINATION_TOTAL; index += 1) {
          rows.push({
            id: crypto.randomUUID(),
            // The first PAGINATION_TIE_COUNT rows share one instant so the
            // `id` tiebreak is the only thing that can order them.
            createdAt:
              index < PAGINATION_TIE_COUNT
                ? PAGINATION_BASE
                : new Date(
                    PAGINATION_BASE.getTime() +
                      (index - PAGINATION_TIE_COUNT + 1) * 60_000,
                  ),
          });
        }
        await integrationPrisma().humanDecision.createMany({
          data: rows.map((row) =>
            pendingDecisionData(tenantA, {
              id: row.id,
              createdAt: row.createdAt,
            }),
          ),
        });
        await integrationPrisma().humanDecision.createMany({
          data: Array.from({ length: PAGINATION_OTHER_TENANT_TOTAL }, () =>
            pendingDecisionData(tenantB, { createdAt: PAGINATION_BASE }),
          ),
        });

        const expectedIds = [...rows]
          .sort(
            (left, right) =>
              left.createdAt.getTime() - right.createdAt.getTime() ||
              (left.id < right.id ? -1 : 1),
          )
          .map((row) => row.id);

        const { repo } = makeHarness(tenantA);
        const firstPage = await repo.listPending({ page: 1, limit: 20 });
        const secondPage = await repo.listPending({ page: 2, limit: 20 });

        expect(firstPage.pageIndex0).toBe(0);
        expect(firstPage.pageSize).toBe(20);
        expect(firstPage.totalCount).toBe(PAGINATION_TOTAL);
        expect(firstPage.pageCount).toBe(2);
        expect(firstPage.items).toHaveLength(20);
        expect(firstPage.items.map((item) => item.id)).toEqual(
          expectedIds.slice(0, 20),
        );

        expect(secondPage.pageIndex0).toBe(1);
        expect(secondPage.totalCount).toBe(PAGINATION_TOTAL);
        expect(secondPage.pageCount).toBe(2);
        expect(secondPage.items).toHaveLength(PAGINATION_TOTAL - 20);
        expect(secondPage.items.map((item) => item.id)).toEqual(
          expectedIds.slice(20),
        );

        const firstTie = firstPage.items.slice(0, PAGINATION_TIE_COUNT);
        expect(
          firstTie.every(
            (item) => item.createdAt.getTime() === PAGINATION_BASE.getTime(),
          ),
        ).toBe(true);
        // Non-vacuous: the page count excludes the other tenant entirely.
        await expect(
          integrationPrisma().humanDecision.count({
            where: { source: RESTOCK_SOURCE, status: 'PENDING' },
          }),
        ).resolves.toBe(PAGINATION_TOTAL + PAGINATION_OTHER_TENANT_TOTAL);
      });

      it('reports an empty tenant queue as totalCount 0 and pageCount 0', async () => {
        const tenantId = await seedTenant('Empty Queue Tenant');
        const otherTenant = await seedTenant('Empty Queue Other Tenant');
        await seedDecision(pendingDecisionData(otherTenant));

        const page = await makeHarness(tenantId).repo.listPending({
          page: 1,
          limit: 20,
        });

        expect(page).toEqual({
          items: [],
          pageIndex0: 0,
          pageSize: 20,
          totalCount: 0,
          pageCount: 0,
        });
      });
    });

    describe('case-insensitive literal productName search', () => {
      it('matches case-insensitively and stays inside the calling tenant', async () => {
        const tenantA = await seedTenant('Search Tenant A');
        const tenantB = await seedTenant('Search Tenant B');
        const fixture = await seedSearchFixture(tenantA);
        await seedDecision(
          pendingDecisionData(tenantB, { productName: 'Cafe de Altura' }),
        );

        const { repo } = makeHarness(tenantA);
        const lower = await repo.listPending({
          page: 1,
          limit: 20,
          search: 'cafe de altura',
        });
        expect(lower.items.map((item) => item.id)).toEqual([fixture.caseRow]);
        expect(lower.totalCount).toBe(1);

        const upper = await repo.listPending({
          page: 1,
          limit: 20,
          search: 'CAFE DE ALTURA',
        });
        expect(upper.items.map((item) => item.id)).toEqual([fixture.caseRow]);

        // Non-vacuous: the identically named tenant B row is committed.
        await expect(
          integrationPrisma().humanDecision.count({
            where: { productName: 'Cafe de Altura' },
          }),
        ).resolves.toBe(2);
      });

      it('treats % and _ as literal characters instead of LIKE wildcards', async () => {
        const tenantId = await seedTenant('Wildcard Tenant');
        const fixture = await seedSearchFixture(tenantId);
        const { repo } = makeHarness(tenantId);

        const percent = await repo.listPending({
          page: 1,
          limit: 20,
          search: '100%',
        });
        expect(percent.items.map((item) => item.id)).toEqual([
          fixture.percentRow,
        ]);

        const underscore = await repo.listPending({
          page: 1,
          limit: 20,
          search: 'Cafe_',
        });
        expect(underscore.items.map((item) => item.id)).toEqual([
          fixture.underscoreRow,
        ]);

        // Non-vacuous: both decoys persist and an unescaped pattern would have
        // matched them (`100%` -> `100x`, `Cafe_` -> `CafeX` / `Cafe `).
        await expect(
          integrationPrisma().humanDecision.count({
            where: { productName: 'Cafe 100x puro' },
          }),
        ).resolves.toBe(1);
        await expect(
          integrationPrisma().humanDecision.count({
            where: { productName: 'CafeXEspecial' },
          }),
        ).resolves.toBe(1);
      });

      it('treats the backslash as a literal character instead of an escape introducer', async () => {
        const tenantId = await seedTenant('Backslash Tenant');
        const fixture = await seedSearchFixture(tenantId);
        const { repo } = makeHarness(tenantId);

        const page = await repo.listPending({
          page: 1,
          limit: 20,
          search: 'Cafe\\Importado',
        });

        expect(page.items.map((item) => item.id)).toEqual([
          fixture.backslashRow,
        ]);
        // Non-vacuous: `CafeImportado` is persisted, and an unescaped `\I`
        // would have degraded to a literal `I` and matched it.
        await expect(
          integrationPrisma().humanDecision.count({
            where: { productName: 'CafeImportado' },
          }),
        ).resolves.toBe(1);
      });
    });

    describe('narrow reviewer SELECT allowlist', () => {
      it('returns exactly the reviewer fields and never the authority, bot-evidence or audit columns', async () => {
        const tenantId = await seedTenant('Allowlist Tenant');
        const variantId = crypto.randomUUID();
        const observedAt = new Date('2026-09-29T09:00:00.000Z');
        const ackReceivedAt = new Date('2026-09-30T12:05:00.000Z');
        // Representative excluded columns seeded non-null: pending has
        // sourceRequestId, canonicalRequestHash, submittedCredentialId,
        // tenantId, source and updatedAt; resolved also has resolutionRequestId,
        // applicationOutcome, applicationAttemptId, applicationEvidenceHash and
        // ackReceivedAt. The fixture separately populates ALLOWED reviewer
        // fields (variantId, stock observation pair, createdAt, resolvedAt and
        // reviewer snapshots) to check their exact projected shape.
        // Deliberately NOT seeded (and therefore NULL in PostgreSQL): the STALE
        // CHECK forbids provider evidence and `applicationAttemptedAt`, and
        // `applicationEvidenceCode` / `resolvedById` are optional — those
        // entries are still asserted absent by key, so the exclusion proof does
        // not depend on the seeded value being non-null.
        const pendingId = await seedDecision(
          pendingDecisionData(tenantId, {
            sourceRequestId: 'bot-request-id',
            canonicalRequestHash: 'canonical-hash',
            variantId,
            observedStockAtRequest: 0,
            stockObservedAt: observedAt,
          }),
        );
        const resolvedId = await seedDecision(
          resolvedDecisionData(tenantId, {
            resolutionRequestId: 'resolution-request-id',
            // STALE: the outcome/evidence CHECK requires the attempt, the hash
            // and the backend receipt, and forbids provider evidence.
            applicationOutcome: 'STALE',
            applicationAttemptId: 'attempt-id',
            applicationEvidenceHash: 'evidence-hash',
            ackReceivedAt,
          }),
        );

        const { repo } = makeHarness(tenantId);
        const page = await repo.listPending({ page: 1, limit: 20 });
        const detail = await readDetail(repo, resolvedId);

        expect(page.items).toHaveLength(1);
        expect(page.items[0].id).toBe(pendingId);
        expect(Object.keys(page.items[0]).sort()).toEqual(REVIEW_SELECT_KEYS);
        expect(Object.keys(detail).sort()).toEqual(REVIEW_SELECT_KEYS);
        for (const forbidden of FORBIDDEN_RECORD_KEYS) {
          expect(page.items[0]).not.toHaveProperty(forbidden);
          expect(detail).not.toHaveProperty(forbidden);
        }

        const serialized = JSON.stringify(page.items[0]);
        expect(serialized).not.toContain('bot-request-id');
        expect(serialized).not.toContain('canonical-hash');
        expect(serialized).not.toContain(CREDENTIAL_ID);

        // Non-vacuous: the exact non-null values seeded above for the excluded
        // representative columns are really committed, so their absence from the
        // reviewer record cannot be an artifact of an unset column.
        const persistedPending =
          await integrationPrisma().humanDecision.findUniqueOrThrow({
            where: { id: pendingId },
          });
        expect(persistedPending).toMatchObject({
          sourceRequestId: 'bot-request-id',
          canonicalRequestHash: 'canonical-hash',
          submittedCredentialId: CREDENTIAL_ID,
          variantId,
          observedStockAtRequest: 0,
          tenantId,
          source: RESTOCK_SOURCE,
        });
        expect(persistedPending.stockObservedAt?.toISOString()).toBe(
          observedAt.toISOString(),
        );

        const persisted =
          await integrationPrisma().humanDecision.findUniqueOrThrow({
            where: { id: resolvedId },
          });
        expect(persisted).toMatchObject({
          status: 'RESOLVED',
          resolutionRequestId: 'resolution-request-id',
          resolvedByActorId: REVIEWER_ACTOR_ID,
          resolvedByDisplayName: REVIEWER_DISPLAY_NAME,
          applicationOutcome: 'STALE',
          applicationAttemptId: 'attempt-id',
          applicationEvidenceHash: 'evidence-hash',
          tenantId,
          source: RESTOCK_SOURCE,
        });
        expect(persisted.resolvedAt?.toISOString()).toBe(
          RESOLVED_AT.toISOString(),
        );
        expect(persisted.ackReceivedAt?.toISOString()).toBe(
          ackReceivedAt.toISOString(),
        );
        expect(persisted.updatedAt).toBeInstanceOf(Date);
        // The deliberately unseeded entries really are NULL, which is why the
        // by-key absence assertions above — not the seeded value — carry the
        // exclusion proof for this group.
        expect(persisted.applicationEvidenceCode).toBeNull();
        expect(persisted.providerMessageId).toBeNull();
        expect(persisted.providerAcceptedObservedAt).toBeNull();
        expect(persisted.applicationAttemptedAt).toBeNull();
        expect(persisted.resolvedById).toBeNull();
      });
    });

    describe('projection from a real persisted record', () => {
      it('feeds real PENDING and RESOLVED rows straight into the pure reviewer mapper', async () => {
        const tenantId = await seedTenant('Mapper Tenant');
        const observedAt = new Date('2026-09-29T09:00:00.000Z');
        const pendingId = await seedDecision(
          pendingDecisionData(tenantId, {
            observedStockAtRequest: 12,
            stockObservedAt: observedAt,
          }),
        );
        const estimateId = await seedDecision(resolvedDecisionData(tenantId));
        const unavailableId = await seedDecision(
          resolvedDecisionData(tenantId, {
            resolutionAction: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
            restockDays: null,
          }),
        );

        const { repo } = makeHarness(tenantId);
        const pending = await readDetail(repo, pendingId);
        const estimate = await readDetail(repo, estimateId);
        const unavailable = await readDetail(repo, unavailableId);

        const pendingDto = toHumanDecisionReviewResponse(pending, true);
        expect(pendingDto).toMatchObject({
          id: pendingId,
          type: RESTOCK_TYPE,
          status: 'PENDING',
          version: 1,
          resolution: null,
          allowedActions: [
            'PROVIDE_RESTOCK_ESTIMATE',
            'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
          ],
        });
        expect(pendingDto.createdAt).toBe(pending.createdAt.toISOString());
        expect(pendingDto.snapshot).toMatchObject({
          branchId: tenantId,
          branchName: 'Sucursal Centro',
          productName: 'Cafe de altura',
          sku: 'SKU-1',
          requestedQuantity: 5,
          observedStockAtRequest: 12,
          stockObservedAt: observedAt.toISOString(),
        });

        const estimateDto = toHumanDecisionReviewResponse(estimate, true);
        expect(estimateDto).toMatchObject({
          id: estimateId,
          status: 'RESOLVED',
          version: 2,
          allowedActions: [],
          resolution: {
            action: 'PROVIDE_RESTOCK_ESTIMATE',
            restockDays: 3,
            resolvedAt: RESOLVED_AT.toISOString(),
            resolvedBy: {
              id: REVIEWER_ACTOR_ID,
              displayName: REVIEWER_DISPLAY_NAME,
            },
          },
        });

        const unavailableDto = toHumanDecisionReviewResponse(unavailable, true);
        expect(unavailableDto).toMatchObject({
          status: 'RESOLVED',
          version: 2,
          allowedActions: [],
          resolution: {
            action: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
            resolvedAt: RESOLVED_AT.toISOString(),
            resolvedBy: {
              id: REVIEWER_ACTOR_ID,
              displayName: REVIEWER_DISPLAY_NAME,
            },
          },
        });
        expect(unavailableDto.resolution).not.toHaveProperty('restockDays');
      });
    });
  },
);
