import { randomUUID } from 'node:crypto';
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
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
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
// Attach rejection handling immediately, including for operations settled in finally.
const outcome = <T>(promise: PromiseLike<T>) =>
  Promise.resolve(promise).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

describe('live editorial selected reference commit-time protection', () => {
  const clients: Client[] = [];
  let makeEditorial: (client: Client) => CatalogEditorialCore;
  let sql: typeof import('@prisma/client').Prisma.sql;
  beforeAll(async () => {
    // Guarded generated-client bootstrap MUST precede application value imports.
    clients.push(await loadEditorialPostgresClient());
    ({ sql } = (await import('@prisma/client')).Prisma);
    const { PrismaCatalogEditorial } =
      await import('./prisma-catalog-editorial');
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
    for (let i = 1; i < 5; i++)
      clients.push(await loadEditorialPostgresClient());
  });
  afterAll(async () => {
    await Promise.all(clients.map((client) => client.$disconnect()));
  });

  it.each(['asset', 'option', 'rollback'] as const)(
    '%s: witnesses selected-row waits, unrelated progress and persisted outcome',
    async (kind) => {
      const [
        editorialClient,
        gateClient,
        selectedClient,
        unrelatedClient,
        observer,
      ] = clients;
      const seed = await seedEditorialPostgres(observer, `u6-${randomUUID()}`);
      const { ids: i, values: v } = seed;
      const scope = {
        actorId: i.userId,
        tenantId: i.tenantId,
        productId: i.productId,
      };
      const candidate: EditorialDocument = {
        commercialTitle: null,
        description: null,
        mediaRefs: [i.assetId],
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
      // A committed empty baseline avoids acquiring a Product FK lock in the gate.
      // Create reads this row without waiting, then waits at its later UPSERT.
      await observer.$executeRaw(sql`INSERT INTO catalog_editorial_states
        ("tenantId", "productId", cycle) VALUES (${i.tenantId}, ${i.productId}, 1)`);
      const baseline = await readEditorialRows(
        observer,
        i.tenantId,
        i.productId,
      );
      const [editorialPid, gatePid, selectedPid, unrelatedPid] =
        await Promise.all(
          [editorialClient, gateClient, selectedClient, unrelatedClient].map(
            currentBackendPid,
          ),
        );
      const ready = deferred<void>();
      const release = deferred<void>();
      const key = `u6-${kind}`;
      const gate = outcome(
        gateClient.$transaction(async (tx) => {
          await tx.$queryRaw(sql`SELECT cycle FROM catalog_editorial_states
            WHERE "tenantId" = ${i.tenantId} AND "productId" = ${i.productId} FOR UPDATE`);
          if (kind === 'rollback') {
            // Invisible to the editorial receipt SELECT until this gate commits.
            // The later duplicate receipt INSERT must roll back editorial's UPSERT.
            await tx.$executeRaw(sql`INSERT INTO catalog_editorial_create_receipts
              ("tenantId", "productId", "actorId", "idempotencyKey", request, result)
              VALUES (${i.tenantId}, ${i.productId}, ${i.userId}, ${key},
                '{"rawGate":true}'::jsonb, '{"rawGate":true}'::jsonb)`);
          }
          ready.resolve();
          await release.promise;
        }),
      );
      let write: ReturnType<typeof outcome> | undefined;
      let selected: ReturnType<typeof outcome> | undefined;
      let unrelated: ReturnType<typeof outcome> | undefined;
      try {
        await bounded(ready.promise);
        write = outcome(
          makeEditorial(editorialClient).create(scope, {
            expectedCycle: 1,
            idempotencyKey: key,
            document: candidate,
          }),
        );
        const editorialBlockers = await waitForLockWait(observer, editorialPid);
        expect(editorialBlockers).toContain(gatePid);
        // The actual core is now past selected-reference validation, at UPSERT.
        selected = outcome(
          kind === 'option'
            ? selectedClient.$executeRaw(sql`UPDATE editorial_options
                SET "archivedAt" = TIMESTAMP '2026-01-01 00:00:00'
                WHERE "definitionId" = ${i.definitionId} AND code = ${v.activeOptionCode}`)
            : selectedClient.$executeRaw(sql`DELETE FROM private_media_assets
                WHERE id = ${i.assetId} AND "tenantId" = ${i.tenantId}`),
        );
        const selectedBlockers = await waitForLockWait(observer, selectedPid);
        expect(selectedBlockers).toContain(editorialPid);
        unrelated = outcome(
          kind === 'option'
            ? unrelatedClient.$executeRaw(sql`UPDATE editorial_options
                SET "archivedAt" = TIMESTAMP '2026-01-01 00:00:00'
                WHERE "definitionId" = ${i.definitionId} AND code = ${v.unrelatedOptionCode}`)
            : unrelatedClient.$executeRaw(sql`DELETE FROM private_media_assets
                WHERE id = ${i.unrelatedAssetId} AND "tenantId" = ${i.tenantId}`),
        );
        // Completion BEFORE gate release proves no wait on the held editorial tx.
        expect(await bounded(unrelated)).toEqual({ ok: true, value: 1 });
        const unrelatedWait = await observer.$queryRaw<
          { blockers: number[] }[]
        >`
          SELECT pg_blocking_pids(${unrelatedPid}::int) AS blockers`;
        expect(unrelatedWait[0].blockers).toEqual([]);
        expect(await waitForLockWait(observer, selectedPid)).toContain(
          editorialPid,
        );
        // Read committed evidence: selected is unchanged while unrelated changed.
        if (kind === 'option') {
          const options = await observer.$queryRaw<
            { code: string; active: boolean }[]
          >`
            SELECT code, "archivedAt" IS NULL AS active FROM editorial_options
            WHERE "definitionId" = ${i.definitionId}`;
          expect(options).toEqual(
            expect.arrayContaining([
              { code: v.activeOptionCode, active: true },
              { code: v.unrelatedOptionCode, active: false },
            ]),
          );
        } else {
          const assets = await observer.$queryRaw<{ id: string }[]>`
            SELECT id FROM private_media_assets WHERE "tenantId" = ${i.tenantId}`;
          expect(assets).toEqual([{ id: i.assetId }]);
        }
        release.resolve();
        const written = await bounded(write);
        const selectedResult = await bounded(selected);
        expect(selectedResult).toEqual({ ok: true, value: 1 });
        const rows = await readEditorialRows(observer, i.tenantId, i.productId);
        if (kind === 'rollback') {
          expect(written.ok).toBe(false);
          if (written.ok)
            throw new Error('Expected late duplicate receipt failure');
          expect(written.error).toMatchObject({
            code: 'P2010',
            meta: { code: '23505' },
          });
          expect(rows.states).toEqual(baseline.states);
          expect(rows.createReceipts).toHaveLength(1);
          expect(rows.createReceipts[0]).toMatchObject({
            idempotencyKey: key,
            request: { rawGate: true },
            result: { rawGate: true },
          });
        } else {
          expect(written.ok).toBe(true);
          expect(rows.states).toHaveLength(1);
          expect(rows.states[0]).toMatchObject({
            cycle: 2,
            draftRevision: 1,
            draftDocument: candidate,
          });
          expect(rows.createReceipts).toHaveLength(1);
          expect(rows.createReceipts[0]).toMatchObject({
            ...scope,
            idempotencyKey: key,
            request: { expectedCycle: 1, document: candidate },
            result: written.ok ? written.value : null,
          });
        }
        expect(rows.saveReceipts).toEqual([]);
        if (kind === 'option') {
          expect(
            await observer.$queryRaw`SELECT "archivedAt" IS NOT NULL AS archived
            FROM editorial_options WHERE "definitionId" = ${i.definitionId}
            AND code = ${v.activeOptionCode}`,
          ).toEqual([{ archived: true }]);
        } else {
          expect(
            await observer.$queryRaw`SELECT id FROM private_media_assets
            WHERE id = ${i.assetId}`,
          ).toEqual([]);
        }
        console.info('U6 evidence', {
          kind,
          editorialPid,
          gatePid,
          selectedPid,
          unrelatedPid,
          editorialBlockers,
          selectedBlockers,
          unrelated: 'completed before release; blockers=[]',
          editorial:
            kind === 'rollback'
              ? 'P2010/23505; baseline unchanged'
              : 'committed state + receipt',
          selected: 'success; affected rows=1 after release',
        });
      } finally {
        release.resolve();
        await Promise.all([gate, write, selected, unrelated]);
      }
      expect(await gate).toEqual({ ok: true, value: undefined });
    },
  );
});
