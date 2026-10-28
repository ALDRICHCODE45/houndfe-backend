import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { CatalogEditorialCore } from '../application/catalog-editorial-core';
import type { EditorialDocument } from '../domain/document';
import { loadEditorialPostgresClient } from './editorial-coordination-postgres-binding';
import {
  currentBackendPid,
  readEditorialRows,
  seedEditorialPostgres,
  waitForLockWait,
} from './editorial-coordination-postgres-fixture';

type Client = Awaited<ReturnType<typeof loadEditorialPostgresClient>>;
type Scope = { tenantId: string; productId: string };
type Operation = 'publish' | 'discard';
const operations: Operation[] = ['publish', 'discard'];
const outcome = <T>(promise: PromiseLike<T>) =>
  Promise.resolve(promise).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Observation exceeded 5s')),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe('live publish/discard transaction, replay and stale-tab proofs (T6)', () => {
  const clients: Client[] = [];
  let makeEditorial: (client: Client) => CatalogEditorialCore;
  let sql: typeof import('@prisma/client').Prisma.sql;
  beforeAll(async () => {
    // No application value import may precede the guarded client bootstrap.
    clients.push(await loadEditorialPostgresClient());
    ({ sql } = (await import('@prisma/client')).Prisma);
    const { PrismaCatalogEditorial } = await import('./prisma-catalog-editorial');
    const { PrismaEditorialAuthority } =
      await import('./prisma-editorial-authority');
    const { createCoordinatedEditorialWriteAuthority } =
      await import('./prisma-coordinated-editorial-authority');
    makeEditorial = (client) =>
      new PrismaCatalogEditorial(
        client,
        new PrismaEditorialAuthority(client),
        undefined,
        undefined,
        createCoordinatedEditorialWriteAuthority,
      );
    for (let n = 1; n < 5; n++) clients.push(await loadEditorialPostgresClient());
  });
  afterAll(async () => {
    await Promise.all(clients.map((client) => client.$disconnect()));
  });

  async function fixture() {
    const observer = clients[4];
    const { ids: i, values: v } = await seedEditorialPostgres(
      observer,
      `t6-${randomUUID()}`,
    );
    // Local extension: the shared seed deliberately grants read/update only.
    await observer.$executeRaw(sql`INSERT INTO permissions (id, subject, action)
      VALUES (${randomUUID()}, 'ProductEditorialDraft', 'publish')
      ON CONFLICT (subject, action) DO NOTHING`);
    await observer.$executeRaw(sql`INSERT INTO role_permissions (id, "roleId", "permissionId")
      SELECT ${randomUUID()}, ${i.roleId}, id FROM permissions
      WHERE subject = 'ProductEditorialDraft' AND action = 'publish'`);
    const scope = {
      actorId: i.userId,
      tenantId: i.tenantId,
      productId: i.productId,
    };
    const document: EditorialDocument = {
      commercialTitle: '  Live publication  ',
      description: null,
      mediaRefs: [],
      familyCode: i.familyId,
      values: [
        {
          code: i.definitionId,
          owner: 'product',
          variantId: null,
          type: 'single',
          value: v.activeOptionCode,
        },
      ],
    };
    const core = makeEditorial(clients[0]);
    const key = `t6-${randomUUID()}`;
    const created = await core.create(scope, {
      expectedCycle: null,
      idempotencyKey: key,
      document,
    });
    expect(created).toMatchObject({
      cycle: 1,
      draft: { revision: 1, document },
    });
    return {
      i,
      v,
      scope,
      document,
      core,
      key,
      request: { expectedCycle: 1, expectedRevision: 1, idempotencyKey: key },
    };
  }
  async function readAll({ tenantId, productId }: Scope) {
    const observer = clients[4];
    const rows = await readEditorialRows(observer, tenantId, productId);
    const publishReceipts = await observer.$queryRaw<
      Record<string, unknown>[]
    >(sql`SELECT * FROM catalog_editorial_publish_receipts
      WHERE "tenantId" = ${tenantId} AND "productId" = ${productId}
      ORDER BY "actorId", "idempotencyKey"`);
    const discardReceipts = await observer.$queryRaw<
      Record<string, unknown>[]
    >(sql`SELECT * FROM catalog_editorial_discard_receipts
      WHERE "tenantId" = ${tenantId} AND "productId" = ${productId}
      ORDER BY "actorId", "idempotencyKey"`);
    return { ...rows, publishReceipts, discardReceipts };
  }
  // Static identifier allowlist; all data remains parameterized.
  const table = (operation: Operation) =>
    operation === 'publish'
      ? sql`catalog_editorial_publish_receipts`
      : sql`catalog_editorial_discard_receipts`;
  function gateState(
    scope: Scope,
    extra?: (tx: Prisma.TransactionClient) => Promise<void>,
  ) {
    const ready = deferred();
    const release = deferred();
    const settled = outcome(
      clients[1].$transaction(async (tx) => {
        await tx.$queryRaw(sql`SELECT cycle FROM catalog_editorial_states
          WHERE "tenantId" = ${scope.tenantId} AND "productId" = ${scope.productId} FOR UPDATE`);
        if (extra) await extra(tx);
        ready.resolve();
        await release.promise;
      }),
    );
    // Gate setup failures must not leave an unresolvable ready wait.
    const entered = Promise.race([
      ready.promise,
      settled.then((result) => {
        if (!result.ok) throw result.error;
      }),
    ]);
    void entered.catch(() => undefined);
    return { release, settled, entered };
  }

  it.each(operations)(
    '%s wins; competing transition waits on Product and becomes stale',
    async (winner) => {
      const f = await fixture();
      const loser: Operation = winner === 'publish' ? 'discard' : 'publish';
      const [writerPid, gatePid, competitorPid] = await Promise.all(
        clients.slice(0, 3).map(currentBackendPid),
      );
      const baseline = await readAll(f.scope);
      const gate = gateState(f.scope);
      let write: ReturnType<typeof outcome> | undefined;
      let competitor: ReturnType<typeof outcome> | undefined;
      try {
        await bounded(gate.entered);
        write = outcome(f.core[winner](f.scope, f.request));
        const writerBlockers = await waitForLockWait(clients[4], writerPid);
        expect(writerBlockers).toContain(gatePid);
        competitor = outcome(
          makeEditorial(clients[2])[loser](f.scope, {
            ...f.request,
            idempotencyKey: `competitor-${f.key}`,
          }),
        );
        const competitorBlockers = await waitForLockWait(
          clients[4],
          competitorPid,
        );
        expect(competitorBlockers).toContain(writerPid);
        // Identify the locked relation, not merely an arbitrary authority lock.
        const locks = await clients[4].$queryRaw<
          { mode: string; relation: string }[]
        >(sql`SELECT mode, relation::regclass::text AS relation FROM pg_locks
          WHERE pid = ${competitorPid} AND locktype = 'tuple' AND granted`);
        expect(locks).toEqual(
          expect.arrayContaining([
            { mode: 'AccessExclusiveLock', relation: 'products' },
          ]),
        );
        expect(await readAll(f.scope)).toEqual(baseline);
        gate.release.resolve();
        const result = await bounded(write);
        expect(result.ok).toBe(true);
        expect(await bounded(competitor)).toMatchObject({
          ok: false,
          error: { message: 'CONFLICT' },
        });
        const rows = await readAll(f.scope);
        expect(rows.states).toEqual([
          expect.objectContaining({
            cycle: 1,
            draftRevision: null,
            draftDocument: null,
            basePublishedRevision: null,
            publishedRevision: winner === 'publish' ? 1 : null,
            publishedDocument: winner === 'publish' ? f.document : null,
          }),
        ]);
        expect(rows.createReceipts).toEqual(baseline.createReceipts);
        expect(rows.saveReceipts).toEqual([]);
        expect(rows[`${loser}Receipts`]).toEqual([]);
        expect(rows[`${winner}Receipts`]).toEqual([
          expect.objectContaining({
            ...f.scope,
            idempotencyKey: f.key,
            request: { expectedCycle: 1, expectedRevision: 1 },
            result: result.ok ? result.value : null,
          }),
        ]);
        console.info('T6 Product serialization', {
          winner,
          writerPid,
          gatePid,
          competitorPid,
          writerBlockers,
          competitorBlockers,
        });
      } finally {
        gate.release.resolve();
        await Promise.all([gate.settled, write, competitor]);
      }
      expect(await gate.settled).toEqual({ ok: true, value: undefined });
    },
  );

  it.each(['publish-reference', 'publish-rollback', 'discard-rollback'] as const)(
    '%s: commit-time reference protection or exact late-receipt rollback',
    async (kind) => {
      const operation: Operation = kind.startsWith('publish')
        ? 'publish'
        : 'discard';
      const rollback = kind.endsWith('rollback');
      const f = await fixture();
      const baseline = await readAll(f.scope);
      const [writerPid, gatePid, selectedPid, unrelatedPid] = await Promise.all(
        clients.slice(0, 4).map(currentBackendPid),
      );
      const gate = gateState(
        f.scope,
        rollback
          ? async (tx) => {
              // Invisible at receipt lookup; state UPDATE must precede failure.
              await tx.$executeRaw(sql`INSERT INTO ${table(operation)}
                ("tenantId", "productId", "actorId", "idempotencyKey", request, result)
                VALUES (${f.i.tenantId}, ${f.i.productId}, ${f.i.userId}, ${f.key},
                  '{"rawGate":true}'::jsonb, '{"rawGate":true}'::jsonb)`);
            }
          : undefined,
      );
      let write: ReturnType<typeof outcome> | undefined;
      let selected: ReturnType<typeof outcome> | undefined;
      let unrelated: ReturnType<typeof outcome> | undefined;
      try {
        await bounded(gate.entered);
        write = outcome(f.core[operation](f.scope, f.request));
        const writerBlockers = await waitForLockWait(clients[4], writerPid);
        expect(writerBlockers).toContain(gatePid);
        if (!rollback) {
          // Writer is past validation at state UPDATE, retaining option locks.
          selected = outcome(
            clients[2].$executeRaw(sql`UPDATE editorial_options
              SET "archivedAt" = TIMESTAMP '2026-01-01 00:00:00'
              WHERE "definitionId" = ${f.i.definitionId} AND code = ${f.v.activeOptionCode}`),
          );
          expect(await waitForLockWait(clients[4], selectedPid)).toContain(
            writerPid,
          );
          unrelated = outcome(
            clients[3].$executeRaw(sql`UPDATE editorial_options
              SET "archivedAt" = TIMESTAMP '2026-01-01 00:00:00'
              WHERE "definitionId" = ${f.i.definitionId} AND code = ${f.v.unrelatedOptionCode}`),
          );
          expect(await bounded(unrelated)).toEqual({ ok: true, value: 1 });
          expect(
            await clients[4].$queryRaw(
              sql`SELECT pg_blocking_pids(${unrelatedPid}::int) AS blockers`,
            ),
          ).toEqual([{ blockers: [] }]);
          expect(
            await clients[4].$queryRaw(
              sql`SELECT code, "archivedAt" IS NULL AS active
              FROM editorial_options WHERE "definitionId" = ${f.i.definitionId}
              AND code IN (${f.v.activeOptionCode}, ${f.v.unrelatedOptionCode})`,
            ),
          ).toEqual(
            expect.arrayContaining([
              { code: f.v.activeOptionCode, active: true },
              { code: f.v.unrelatedOptionCode, active: false },
            ]),
          );
          expect(await waitForLockWait(clients[4], selectedPid)).toContain(
            writerPid,
          );
        }
        expect(await readAll(f.scope)).toEqual(baseline);
        gate.release.resolve();
        const result = await bounded(write);
        const rows = await readAll(f.scope);
        if (rollback) {
          expect(result).toMatchObject({
            ok: false,
            error: { code: 'P2010', meta: { code: '23505' } },
          });
          const gateRows = await clients[4].$queryRaw<
            Record<string, unknown>[]
          >(sql`SELECT * FROM ${table(operation)} WHERE "tenantId" = ${f.i.tenantId}
            AND "productId" = ${f.i.productId}`);
          expect(gateRows).toEqual([
            expect.objectContaining({
              ...f.scope,
              idempotencyKey: f.key,
              request: { rawGate: true },
              result: { rawGate: true },
            }),
          ]);
          // Exact state/all namespaces: only the externally inserted row survives.
          expect(rows).toEqual({
            ...baseline,
            [`${operation}Receipts`]: gateRows,
          });
        } else {
          expect(result).toEqual({
            ok: true,
            value: {
              cycle: 1,
              draft: null,
              published: { revision: 1, document: f.document },
            },
          });
          expect(await bounded(selected!)).toEqual({ ok: true, value: 1 });
          expect(
            await clients[4].$queryRaw(
              sql`SELECT "archivedAt" IS NOT NULL AS archived
              FROM editorial_options WHERE "definitionId" = ${f.i.definitionId}
              AND code = ${f.v.activeOptionCode}`,
            ),
          ).toEqual([{ archived: true }]);
          expect(rows.states).toEqual([
            expect.objectContaining({
              cycle: 1,
              draftRevision: null,
              draftDocument: null,
              publishedRevision: 1,
              publishedDocument: f.document,
              basePublishedRevision: null,
            }),
          ]);
          expect(rows.publishReceipts).toEqual([
            expect.objectContaining({
              ...f.scope,
              idempotencyKey: f.key,
              request: { expectedCycle: 1, expectedRevision: 1 },
              result: result.ok ? result.value : null,
            }),
          ]);
          expect(rows.createReceipts).toEqual(baseline.createReceipts);
          expect(rows.saveReceipts).toEqual([]);
          expect(rows.discardReceipts).toEqual([]);
        }
        console.info('T6 commit boundary', {
          kind,
          writerPid,
          gatePid,
          selectedPid,
          unrelatedPid,
          writerBlockers,
          result: rollback ? 'P2010/23505' : 'committed',
        });
      } finally {
        gate.release.resolve();
        await Promise.all([gate.settled, write, selected, unrelated]);
      }
      expect(await gate.settled).toEqual({ ok: true, value: undefined });
    },
  );

  it.each(operations)(
    '%s replay never restores state; stale mutations conflict after initialize',
    async (operation) => {
      const f = await fixture();
      // Same key in create/save/transitions must never cross receipt namespaces.
      const saved = await f.core.save(f.scope, {
        ...f.request,
        document: f.document,
      });
      expect(saved.draft?.revision).toBe(2);
      const request = { ...f.request, expectedRevision: 2 };
      const recorded = await f.core[operation](f.scope, request);
      expect(recorded).toEqual({
        cycle: 1,
        draft: null,
        published:
          operation === 'publish'
            ? { revision: 1, document: f.document }
            : null,
      });
      const initialized = await f.core.initialize(f.scope, {
        expectedCycle: 1,
        idempotencyKey: `initialize-${f.key}`,
      });
      expect(initialized).toMatchObject({ cycle: 2, draft: { revision: 1 } });
      const baseline = await readAll(f.scope);
      expect(baseline.createReceipts).toHaveLength(2);
      expect(baseline.saveReceipts).toHaveLength(1);
      expect(baseline[`${operation}Receipts`]).toHaveLength(1);
      expect(await f.core[operation](f.scope, request)).toEqual(recorded);
      expect(await readAll(f.scope)).toEqual(baseline);
      await expect(
        f.core[operation](f.scope, { ...request, expectedCycle: 2 }),
      ).rejects.toThrow('CONFLICT');
      expect(await readAll(f.scope)).toEqual(baseline);
      for (const stale of ['save', 'publish', 'discard'] as const) {
        const staleRequest = {
          ...request,
          idempotencyKey: `stale-${stale}-${f.key}`,
        };
        await expect(
          stale === 'save'
            ? f.core.save(f.scope, { ...staleRequest, document: f.document })
            : f.core[stale](f.scope, staleRequest),
        ).rejects.toThrow('CONFLICT');
        expect(await readAll(f.scope)).toEqual(baseline);
      }
      // OTHER transition, same key, fresh pair. Discard initialization needs a title.
      const fresh = await f.core.save(f.scope, {
        expectedCycle: 2,
        expectedRevision: 1,
        idempotencyKey: `fresh-${f.key}`,
        document: f.document,
      });
      const other: Operation = operation === 'publish' ? 'discard' : 'publish';
      const isolated = await f.core[other](f.scope, {
        expectedCycle: 2,
        expectedRevision: fresh.draft!.revision,
        idempotencyKey: f.key,
      });
      expect(isolated).toMatchObject({ cycle: 2, draft: null });
      const rows = await readAll(f.scope);
      expect(rows.publishReceipts).toHaveLength(1);
      expect(rows.discardReceipts).toHaveLength(1);
      expect(rows[`${operation}Receipts`]).toEqual(
        baseline[`${operation}Receipts`],
      );
      expect(rows[`${other}Receipts`][0]).toMatchObject({
        ...f.scope,
        idempotencyKey: f.key,
        result: isolated,
      });
    },
  );
});
