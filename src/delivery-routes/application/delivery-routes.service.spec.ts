/**
 * APPLICATION UNIT SPEC: DeliveryRoutesService — delivery-routes / WU2+WU3.
 *
 * Covers the use-case orchestration contract (tasks.md 3.12):
 *   - `checkInStop` transaction choreography: stop flip + Sale mirror
 *     (`markSaleDelivered` via the SALE_REPOSITORY port) inside one
 *     `repo.runInTransaction`; the next-stop outbox row is published
 *     inside the SAME transaction when a next stop exists (WU3).
 *   - `list` driver-only scoping via `request.ability.can('create',
 *     'DeliveryRoute')`.
 *   - `start` eligible → proceeds / DB conflict (P2002 race) →
 *     `DeliveryRouteSaleAlreadyInActiveRouteError` (409 domain contract).
 *   - Error mapping: not-found → 404 (`DeliveryRouteNotFoundError`),
 *     invalid transition → 422 (`DeliveryRouteInvalidTransitionError`).
 *
 * All ports (DELIVERY_ROUTE_REPOSITORY, SALE_REPOSITORY, ROUTE_OPTIMIZER,
 * OutboxWriterService) are Jest mocks — no real DB, no NestJS DI
 * container.
 */
import { Prisma } from '@prisma/client';
import {
  DeliveryRoutesService,
  captureRouteTransitionExpectation,
  type DeliveryRouteRequestContext,
} from './delivery-routes.service';
import { DeliveryRoute } from '../domain/delivery-route.entity';
import {
  DELIVERY_ROUTE_REPOSITORY,
  type DeliveryRouteReadModel,
  type IDeliveryRouteRepository,
} from '../domain/delivery-route.repository';
import { SALE_REPOSITORY, type ISaleRepository } from '../../sales/domain/sale.repository';
import { SaleNotDeliverableError } from '../../sales/domain/sale.errors';
import {
  ROUTE_OPTIMIZER,
  type IRouteOptimizer,
} from '../domain/ports/route-optimizer.port';
import {
  DeliveryRouteInvalidTransitionError,
  DeliveryRouteNotFoundError,
  DeliveryRouteSaleAlreadyInActiveRouteError,
} from '../domain/delivery-route.errors';
import {
  BusinessRuleViolationError,
  EntityNotFoundError,
} from '../../shared/domain/domain-error';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { ClsService } from 'nestjs-cls';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import type { AppAbility } from '../../auth/authorization/domain/permission';
import type { OutboxWriterService } from '../../shared/outbox/outbox-writer.service';
import {
  computeDeliveryNextStopIdempotencyKey,
  type DeliveryNextStopNotifyPayload,
} from '../outbox/delivery-route-outbox.types';

const TENANT_ID = 'tenant-1';
const OTHER_TENANT_ID = 'tenant-2';
const USER_ID = 'driver-1';
const NOW = new Date('2026-08-01T12:00:00.000Z');

/** Build a real ACTIVE/DRAFT aggregate — the aggregate is production code,
 *  only the ports are mocked. */
const makeRoute = async (
  saleIds: string[],
  status: 'DRAFT' | 'ACTIVE' = 'ACTIVE',
): Promise<DeliveryRoute> => {
  const route = await DeliveryRoute.create({
    tenantId: TENANT_ID,
    driverUserId: USER_ID,
    saleIds,
    checkSaleEligibility: jest.fn(async () => ({
      deliveryStatus: 'PENDING' as const,
      shippingAddressId: 'addr-1',
    })),
    now: NOW,
  });
  if (status === 'ACTIVE') {
    route.start({ now: NOW });
  }
  return route;
};

/** Lazy read-model projection — snapshots the aggregate's current state at
 *  call time so post-mutation reads (e.g. after auto-complete) are accurate. */
const readModelFor = (route: DeliveryRoute): DeliveryRouteReadModel => ({
  id: route.id,
  tenantId: route.tenantId,
  driverUserId: route.driverUserId,
  status: route.status,
  startedAt: route.startedAt,
  completedAt: route.completedAt,
  cancelledAt: route.cancelledAt,
  notes: route.notes,
  createdAt: route.createdAt,
  updatedAt: route.updatedAt,
  driver: { id: route.driverUserId, name: 'Driver One', email: 'driver@example.com' },
  stops: route.stops.map((stop) => ({
    id: stop.id,
    saleId: stop.saleId,
    saleFolio: `F-${stop.sortOrder + 1}`,
    sortOrder: stop.sortOrder,
    status: stop.status,
    checkedInAt: stop.checkedInAt,
    completedAt: stop.completedAt,
    customer: null,
    shippingAddress: null,
  })),
});

/**
 * Minimal in-memory sale projection used by the next-stop payload composer.
 * `customer` / `shippingAddress` are nullable so the outbox composer's
 * "missing customer" degrade path can be exercised with a partial row, and
 * each nullable child carries its own `tenantId` so the composer's
 * post-read tenant filter can be exercised independently.
 */
type SaleCustomerProjection = {
  tenantId: string;
  firstName: string;
  lastName: string;
  email: string;
};

type SaleAddressProjection = Record<string, string | null> & {
  tenantId: string;
};

type SaleProjection = {
  folio: string;
  customer: SaleCustomerProjection | null;
  shippingAddress: SaleAddressProjection | null;
};

const saleProjection = (
  saleId: string,
  childTenantIds: {
    customerTenantId?: string;
    addressTenantId?: string;
  } = {},
): SaleProjection => ({
  folio: `F-${saleId}`,
  customer: {
    tenantId: childTenantIds.customerTenantId ?? TENANT_ID,
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: `${saleId}@example.com`,
  },
  shippingAddress: {
    tenantId: childTenantIds.addressTenantId ?? TENANT_ID,
    label: null,
    street: 'Av. Reforma',
    exteriorNumber: '123',
    interiorNumber: null,
    zipCode: '06600',
    neighborhood: 'Centro',
    municipality: 'Cuauhtémoc',
    city: 'CDMX',
    state: 'CDMX',
  },
});

const makeService = (
  overrides: {
    repo?: Partial<IDeliveryRouteRepository>;
    saleRepo?: Partial<Pick<ISaleRepository, 'markSaleDelivered'>>;
    outboxWriter?: Partial<Pick<OutboxWriterService, 'publish'>>;
    saleProjectionMap?: Map<string, SaleProjection | null>;
  } = {},
) => {
  const tx = {} as Prisma.TransactionClient;
  const projectionMap =
    overrides.saleProjectionMap ?? new Map<string, SaleProjection | null>();
  // Default: every sale returns a populated projection.
  if (!overrides.saleProjectionMap) {
    projectionMap.set('sale-1', saleProjection('sale-1'));
    projectionMap.set('sale-2', saleProjection('sale-2'));
  }

  const txPrisma = {
    sale: {
      // `where` is matched by id only; `select` is retained so specs can
      // assert the exact submitted projection (tenant ids included).
      findFirst: jest.fn(
        async ({
          where,
        }: {
          where: { id: string; tenantId?: string };
          select?: unknown;
        }) => {
          return projectionMap.get(where.id) ?? null;
        },
      ),
    },
  };

  const repo = {
    save: jest.fn(async (r: DeliveryRoute) => r),
    commitTransition: jest.fn(() =>
      Promise.resolve({ kind: 'committed' as const }),
    ),
    findById: jest.fn(async () => null),
    findOneWithStops: jest.fn(async () => null),
    list: jest.fn(async () => []),
    runInTransaction: jest.fn(
      async (work: (t: Prisma.TransactionClient) => Promise<unknown>) =>
        work({ ...tx, ...txPrisma } as unknown as Prisma.TransactionClient),
    ),
    ...overrides.repo,
  } as jest.Mocked<IDeliveryRouteRepository>;
  const saleRepo = {
    markSaleDelivered: jest.fn(() =>
      Promise.resolve({ kind: 'delivered' as const }),
    ),
    ...overrides.saleRepo,
  } as jest.Mocked<Pick<ISaleRepository, 'markSaleDelivered'>>;
  const optimizer = { optimize: jest.fn() } as jest.Mocked<IRouteOptimizer>;
  const tenantPrisma = {
    getClient: () => txPrisma,
  } as unknown as TenantPrismaService;
  const cls = {
    get: jest.fn(() => ({ tenantId: TENANT_ID, isSuperAdmin: false })),
  } as unknown as ClsService<TenantClsStore>;
  const outboxWriter = {
    publish: jest.fn(async () => undefined),
    ...overrides.outboxWriter,
  } as jest.Mocked<Pick<OutboxWriterService, 'publish'>>;

  const service = new DeliveryRoutesService(
    repo,
    saleRepo as never,
    optimizer,
    tenantPrisma,
    cls,
    outboxWriter as unknown as OutboxWriterService,
  );
  return { service, repo, saleRepo, cls, tx, txPrisma, outboxWriter };
};

const makeCtx = (can: jest.Mock = jest.fn(() => false)): DeliveryRouteRequestContext => ({
  userId: USER_ID,
  ability: { can } as unknown as AppAbility,
});

// ───────────────────────────────────────────────────────────────────────
// ODD O1 — stateful concurrency harness.
//
// `InMemoryDeliveryRouteStore` models one tenant's persisted
// `delivery_routes` row plus its `delivery_route_stops` rows and the two
// write seams the service can reach during check-in / cancel:
//
//   - `save`             full aggregate replacement (last writer wins)
//   - `commitTransition` tenant-qualified conditional compare-and-commit
//
// `interleaveOnce(hook)` scripts a COMPETING writer that lands between the
// candidate request's load and its commit, so the specs reproduce genuine
// stale snapshots instead of mocks that always return the desired result.
// The store also snapshots/restores on a thrown transaction callback, so a
// rolled-back attempt cannot leak partial writes into the retry.
// ───────────────────────────────────────────────────────────────────────

type PersistedRouteProjection = ReturnType<DeliveryRoute['toPersistence']>;
type PersistedRouteRow = Omit<PersistedRouteProjection, 'stops'>;
type PersistedStopRow = PersistedRouteProjection['stops'][number];

/** Snapshot identity a caller loaded and evaluated before mutating. */
type RouteStateExpectation = {
  status: PersistedRouteRow['status'];
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  updatedAt: Date;
  stops: Array<{
    id: string;
    status: PersistedStopRow['status'];
    checkedInAt: Date | null;
    completedAt: Date | null;
    activeRouteId: string | null;
  }>;
};

const sameTimestamp = (a: Date | null, b: Date | null): boolean =>
  a === b || (a !== null && b !== null && a.getTime() === b.getTime());

const routeMatchesExpectation = (
  row: PersistedRouteRow,
  expected: RouteStateExpectation,
): boolean =>
  row.status === expected.status &&
  sameTimestamp(row.startedAt, expected.startedAt) &&
  sameTimestamp(row.completedAt, expected.completedAt) &&
  sameTimestamp(row.cancelledAt, expected.cancelledAt) &&
  sameTimestamp(row.updatedAt, expected.updatedAt);

const stopMatchesExpectation = (
  row: PersistedStopRow,
  expected: RouteStateExpectation['stops'][number],
): boolean =>
  row.status === expected.status &&
  sameTimestamp(row.checkedInAt, expected.checkedInAt) &&
  sameTimestamp(row.completedAt, expected.completedAt) &&
  row.activeRouteId === expected.activeRouteId;

const stopProjectionChanged = (
  prior: RouteStateExpectation['stops'][number],
  next: PersistedStopRow,
): boolean =>
  prior.status !== next.status ||
  !sameTimestamp(prior.checkedInAt, next.checkedInAt) ||
  !sameTimestamp(prior.completedAt, next.completedAt) ||
  prior.activeRouteId !== next.activeRouteId;

const stateExpectationOf = captureRouteTransitionExpectation;

/** Undo entry recorded while a transaction is open — rollback restores
 *  only what THAT transaction wrote, so an externally committed competing
 *  writer keeps its state (mirrors real per-transaction rollback). */
type TxJournalEntry =
  | { kind: 'route'; previous: PersistedRouteRow }
  | { kind: 'stop'; stopId: string; previous: PersistedStopRow | null }
  | { kind: 'outbox'; previousLength: number };

class InMemoryDeliveryRouteStore {
  private routeRow: PersistedRouteRow;
  private stopRows: PersistedStopRow[];
  private interleave:
    | ((store: InMemoryDeliveryRouteStore) => Promise<void> | void)
    | null = null;
  private transactionClient: Prisma.TransactionClient | null = null;
  private txJournal: TxJournalEntry[] | null = null;
  private externalWriterActive = false;
  /** Every conditional-commit invocation, including stale/retried ones. */
  commitAttempts = 0;
  /** Makes every conditional commit report `stale` (budget-exhaustion path). */
  forceStaleCommits = false;
  readonly outboxRows: Array<{
    idempotencyKey: string;
    currentStopId: string;
  }> = [];

  constructor(route: DeliveryRoute) {
    const { stops, ...routeRow } = route.toPersistence();
    this.routeRow = routeRow;
    this.stopRows = stops.map((stop) => ({ ...stop }));
  }

  attachTransactionClient(client: Prisma.TransactionClient): void {
    this.transactionClient = client;
  }

  interleaveOnce(
    hook: (store: InMemoryDeliveryRouteStore) => Promise<void> | void,
  ): void {
    this.interleave = hook;
  }

  persistedRows(): { route: PersistedRouteRow; stops: PersistedStopRow[] } {
    return {
      route: { ...this.routeRow },
      stops: this.stopRows.map((stop) => ({ ...stop })),
    };
  }

  outboxKeysFor(stopId: string): string[] {
    return this.outboxRows
      .filter((row) => row.currentStopId === stopId)
      .map((row) => row.idempotencyKey);
  }

  recordOutbox(row: { idempotencyKey: string; currentStopId: string }): void {
    if (!this.externalWriterActive) {
      this.txJournal?.push({
        kind: 'outbox',
        previousLength: this.outboxRows.length,
      });
    }
    this.outboxRows.push(row);
  }

  aggregate(): DeliveryRoute {
    return DeliveryRoute.fromPersistence({
      ...this.routeRow,
      stops: this.stopRows.map((stop) => ({ ...stop })),
    });
  }

  findById(input: {
    tenantId: string;
    id: string;
  }): Promise<DeliveryRoute | null> {
    if (
      this.routeRow.tenantId !== input.tenantId ||
      this.routeRow.id !== input.id
    ) {
      return Promise.resolve(null);
    }
    return Promise.resolve(this.aggregate());
  }

  readModel(input: {
    tenantId: string;
    id: string;
  }): DeliveryRouteReadModel | null {
    if (
      this.routeRow.tenantId !== input.tenantId ||
      this.routeRow.id !== input.id
    ) {
      return null;
    }
    return {
      id: this.routeRow.id,
      tenantId: this.routeRow.tenantId,
      driverUserId: this.routeRow.driverUserId,
      status: this.routeRow.status,
      startedAt: this.routeRow.startedAt,
      completedAt: this.routeRow.completedAt,
      cancelledAt: this.routeRow.cancelledAt,
      notes: this.routeRow.notes,
      createdAt: this.routeRow.createdAt,
      updatedAt: this.routeRow.updatedAt,
      driver: {
        id: this.routeRow.driverUserId,
        name: 'Driver One',
        email: 'driver@example.com',
      },
      stops: [...this.stopRows]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((stop) => ({
          id: stop.id,
          saleId: stop.saleId,
          saleFolio: `F-${stop.sortOrder + 1}`,
          sortOrder: stop.sortOrder,
          status: stop.status,
          checkedInAt: stop.checkedInAt,
          completedAt: stop.completedAt,
          customer: null,
          shippingAddress: null,
        })),
    };
  }

  /** Unconditional aggregate replacement — the pre-O1 seam. */
  async save(route: DeliveryRoute): Promise<DeliveryRoute> {
    await this.fireInterleave();
    const { stops, ...routeRow } = route.toPersistence();
    this.journalRouteWrite();
    this.journalAllStops();
    this.routeRow = routeRow;
    this.stopRows = stops.map((stop) => ({ ...stop }));
    return this.aggregate();
  }

  /** Tenant-qualified conditional compare-and-commit — the O1 seam. */
  async commitTransition(input: {
    tenantId: string;
    routeId: string;
    expected: RouteStateExpectation;
    next: DeliveryRoute;
  }): Promise<{ kind: 'committed' | 'stale' | 'missing' }> {
    this.commitAttempts++;
    await this.fireInterleave();
    if (this.forceStaleCommits) {
      return { kind: 'stale' };
    }
    if (
      this.routeRow.tenantId !== input.tenantId ||
      this.routeRow.id !== input.routeId
    ) {
      return { kind: 'missing' };
    }
    if (!routeMatchesExpectation(this.routeRow, input.expected)) {
      return { kind: 'stale' };
    }

    const expectedStops = new Map(
      input.expected.stops.map((stop) => [stop.id, stop]),
    );
    const changes: Array<{ stopId: string; data: PersistedStopRow }> = [];
    for (const stop of input.next.stops) {
      const prior = expectedStops.get(stop.id);
      if (!prior) continue;
      const data = stop.toPersistence();
      if (!stopProjectionChanged(prior, data)) continue;
      const persisted = this.stopRows.find((row) => row.id === stop.id);
      if (!persisted || !stopMatchesExpectation(persisted, prior)) {
        return { kind: 'stale' };
      }
      changes.push({ stopId: stop.id, data });
    }

    this.journalRouteWrite();
    this.routeRow = input.next.toPersistence();
    for (const change of changes) {
      const index = this.stopRows.findIndex((row) => row.id === change.stopId);
      this.journalStopWrite(change.stopId);
      this.stopRows[index] = change.data;
    }
    this.reconcileCompletionFromPersistedStops();
    return { kind: 'committed' };
  }

  async runInTransaction<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (!this.transactionClient) {
      throw new Error('harness: transaction client was not attached');
    }
    const previousJournal = this.txJournal;
    const journal: TxJournalEntry[] = [];
    this.txJournal = journal;
    try {
      return await work(this.transactionClient);
    } catch (error) {
      // Model the enclosing transaction's rollback: undo ONLY the writes
      // this transaction made, so a competing writer that committed in
      // between keeps its state.
      this.applyRollback(journal);
      throw error;
    } finally {
      this.txJournal = previousJournal;
    }
  }

  /**
   * Route auto-completion decided from the PERSISTED stop set (not from a
   * caller snapshot): an ACTIVE route with zero pending stops becomes
   * COMPLETED and its ADR-7 markers are cleared.
   */
  private reconcileCompletionFromPersistedStops(): void {
    const pending = this.stopRows.filter(
      (stop) => stop.status === 'PENDING' || stop.status === 'IN_PROGRESS',
    );
    if (pending.length > 0) return;
    if (this.routeRow.status === 'ACTIVE') {
      this.journalRouteWrite();
      this.routeRow.status = 'COMPLETED';
      this.routeRow.completedAt = new Date(
        this.routeRow.updatedAt.getTime() + 1,
      );
    }
    for (const stop of this.stopRows) {
      if (stop.activeRouteId === null) continue;
      this.journalStopWrite(stop.id);
      stop.activeRouteId = null;
    }
  }

  private journalRouteWrite(): void {
    if (!this.txJournal || this.externalWriterActive) return;
    this.txJournal.push({ kind: 'route', previous: { ...this.routeRow } });
  }

  private journalAllStops(): void {
    for (const stop of this.stopRows) this.journalStopWrite(stop.id);
  }

  private journalStopWrite(stopId: string): void {
    if (!this.txJournal || this.externalWriterActive) return;
    const current = this.stopRows.find((row) => row.id === stopId) ?? null;
    this.txJournal.push({
      kind: 'stop',
      stopId,
      previous: current ? { ...current } : null,
    });
  }

  private applyRollback(journal: TxJournalEntry[]): void {
    for (const entry of [...journal].reverse()) {
      if (entry.kind === 'route') {
        this.routeRow = entry.previous;
        continue;
      }
      if (entry.kind === 'outbox') {
        this.outboxRows.length = entry.previousLength;
        continue;
      }
      const index = this.stopRows.findIndex((row) => row.id === entry.stopId);
      if (entry.previous === null) {
        if (index >= 0) this.stopRows.splice(index, 1);
      } else if (index >= 0) {
        this.stopRows[index] = entry.previous;
      }
    }
  }

  private async fireInterleave(): Promise<void> {
    const hook = this.interleave;
    if (!hook) return;
    this.interleave = null;
    // The competing writer commits in its OWN transaction: its writes are
    // never part of the candidate's journal and survive the candidate's
    // rollback.
    this.externalWriterActive = true;
    try {
      await hook(this);
    } finally {
      this.externalWriterActive = false;
    }
  }
}

/** A competing check-in performed by an independent writer against the
 *  store's own read-modify-commit path. */
const runCompetingCheckIn = async (
  store: InMemoryDeliveryRouteStore,
  routeId: string,
  stopId: string,
  at: Date,
): Promise<void> => {
  const route = await store.findById({ tenantId: TENANT_ID, id: routeId });
  if (!route) throw new Error('competing check-in: route not visible');
  const expected = stateExpectationOf(route);
  const wasPending =
    route.stops.find((stop) => stop.id === stopId)?.status === 'PENDING';
  const checkIn = route.checkInStop({ stopId, now: at });
  const outcome = await store.commitTransition({
    tenantId: TENANT_ID,
    routeId,
    expected,
    next: route,
  });
  if (outcome.kind !== 'committed') {
    throw new Error(`competing check-in did not commit (${outcome.kind})`);
  }
  if (wasPending && checkIn.nextStop) {
    store.recordOutbox({
      idempotencyKey: computeDeliveryNextStopIdempotencyKey({
        tenantId: TENANT_ID,
        currentStopId: checkIn.completedStop.id,
      }),
      currentStopId: checkIn.completedStop.id,
    });
  }
};

/** A competing valid cancellation performed by an independent writer. */
const runCompetingCancel = async (
  store: InMemoryDeliveryRouteStore,
  routeId: string,
  at: Date,
): Promise<void> => {
  const route = await store.findById({ tenantId: TENANT_ID, id: routeId });
  if (!route) throw new Error('competing cancel: route not visible');
  const expected = stateExpectationOf(route);
  route.cancel({ now: at });
  const outcome = await store.commitTransition({
    tenantId: TENANT_ID,
    routeId,
    expected,
    next: route,
  });
  if (outcome.kind !== 'committed') {
    throw new Error(`competing cancel did not commit (${outcome.kind})`);
  }
};

/** Wire the stateful store into the service under test. */
const makeStoreService = (store: InMemoryDeliveryRouteStore) => {
  const built = makeService({
    repo: {
      save: (route: DeliveryRoute) => store.save(route),
      findById: (input: { tenantId: string; id: string }) =>
        store.findById(input),
      findOneWithStops: (input: { tenantId: string; id: string }) =>
        Promise.resolve(store.readModel(input)),
      runInTransaction: <T>(
        work: (tx: Prisma.TransactionClient) => Promise<T>,
      ) => store.runInTransaction(work),
      commitTransition: (input: {
        tx: Prisma.TransactionClient;
        tenantId: string;
        routeId: string;
        expected: RouteStateExpectation;
        next: DeliveryRoute;
      }) => store.commitTransition(input),
    },
    outboxWriter: {
      publish: ((...args: unknown[]) => {
        const payload = args[5] as DeliveryNextStopNotifyPayload;
        store.recordOutbox({
          idempotencyKey: payload.idempotencyKey,
          currentStopId: payload.currentStopId,
        });
      }) as unknown as OutboxWriterService['publish'],
    },
  });
  store.attachTransactionClient(
    built.txPrisma as unknown as Prisma.TransactionClient,
  );
  return built;
};

describe('DeliveryRoutesService (delivery-routes / WU2+WU3)', () => {
  describe('checkInStop — transaction orchestration', () => {
    it('Given an ACTIVE route with a next stop, when a stop is checked in, then the stop flip, the Sale mirror, and the next-stop outbox row all happen inside one transaction', async () => {
      const route = await makeRoute(['sale-1', 'sale-2'], 'ACTIVE');
      const { service, repo, saleRepo, outboxWriter, txPrisma } = makeService({
        repo: {
          findById: jest.fn(async () => route),
          findOneWithStops: jest.fn(async () => readModelFor(route)),
        },
      });

      const dto = await service.checkInStop(
        makeCtx(),
        route.id,
        route.stops[0].id,
      );

      expect(repo.runInTransaction).toHaveBeenCalledTimes(1);
      expect(saleRepo.markSaleDelivered).toHaveBeenCalledTimes(1);
      // The route write is a tenant-qualified CONDITIONAL commit against
      // the snapshot loaded inside the transaction (ODD O1) and is applied
      // BEFORE the sale mirror write.
      expect(repo.commitTransition).toHaveBeenCalledTimes(1);
      const commitArgs = repo.commitTransition.mock.calls[0][0];
      expect(commitArgs.tx).toEqual(txPrisma);
      expect(commitArgs.tenantId).toBe(TENANT_ID);
      expect(commitArgs.routeId).toBe(route.id);
      expect(commitArgs.next).toBe(route);
      // The expectation captures the PRE-mutation state of the snapshot.
      expect(commitArgs.expected.status).toBe('ACTIVE');
      expect(
        commitArgs.expected.stops.find((s) => s.id === route.stops[0].id)
          ?.status,
      ).toBe('PENDING');
      expect(commitArgs.expected.updatedAt).toEqual(NOW);
      // The conditional route commit still runs BEFORE the sale mirror.
      expect(repo.commitTransition.mock.invocationCallOrder[0]).toBeLessThan(
        saleRepo.markSaleDelivered.mock.invocationCallOrder[0],
      );
      // The unconditional full replacement is no longer used on this path.
      expect(repo.save).not.toHaveBeenCalled();
      // Stop flip + route still ACTIVE with a next stop.
      expect(route.stops[0].status).toBe('COMPLETED');
      expect(route.status).toBe('ACTIVE');

      // Outbox row published EXACTLY ONCE with the correct aggregate keys.
      expect(outboxWriter.publish).toHaveBeenCalledTimes(1);
      const callArgs = outboxWriter.publish.mock.calls[0];
      expect(callArgs[0]).toEqual(txPrisma); // tx client (same as the runInTransaction callback's tx)
      expect(callArgs[1]).toBe(TENANT_ID);
      expect(callArgs[2]).toBe('DeliveryRoute');
      expect(callArgs[3]).toBe(route.id);
      expect(callArgs[4]).toBe('delivery.next_stop.notify');
      const payload = callArgs[5] as {
        tenantId: string;
        routeId: string;
        currentStopId: string;
        nextStopId: string;
        nextSaleId: string;
        nextCustomerName: string;
        nextCustomerEmail: string;
        nextAddressLabel: string;
        idempotencyKey: string;
        occurredAt: string;
      };
      expect(payload.tenantId).toBe(TENANT_ID);
      expect(payload.routeId).toBe(route.id);
      expect(payload.currentStopId).toBe(route.stops[0].id);
      expect(payload.nextStopId).toBe(route.stops[1].id);
      expect(payload.nextSaleId).toBe('sale-2');
      expect(payload.nextCustomerName).toBe('Ada Lovelace');
      expect(payload.nextCustomerEmail).toBe('sale-2@example.com');
      expect(payload.nextAddressLabel).toContain('Av. Reforma');
      expect(payload.idempotencyKey).toBe(
        `${TENANT_ID}:${route.stops[0].id}`,
      );
      expect(typeof payload.occurredAt).toBe('string');

      expect(dto.status).toBe('ACTIVE');
      expect(dto.timeline.length).toBeGreaterThan(0);
    });

    it('Given an ACTIVE route, when its last stop is checked in, then the route auto-completes and NO outbox row is emitted (no next stop)', async () => {
      const route = await makeRoute(['sale-1'], 'ACTIVE');
      const { service, repo, saleRepo, outboxWriter } = makeService({
        repo: {
          findById: jest.fn(async () => route),
          findOneWithStops: jest.fn(async () => readModelFor(route)),
        },
      });

      const dto = await service.checkInStop(makeCtx(), route.id, route.stops[0].id);

      expect(route.status).toBe('COMPLETED');
      expect(saleRepo.markSaleDelivered).toHaveBeenCalledTimes(1);
      expect(repo.commitTransition).toHaveBeenCalledTimes(1);
      expect(repo.save).not.toHaveBeenCalled();
      // No next stop ⇒ no outbox row.
      expect(outboxWriter.publish).not.toHaveBeenCalled();
      expect(dto.status).toBe('COMPLETED');
    });

    it('Given a check-in replay (already-COMPLETED stop), when the service is called again, then the aggregate is a no-op AND no second outbox row is published', async () => {
      const route = await makeRoute(['sale-1', 'sale-2'], 'ACTIVE');
      const { service, outboxWriter } = makeService({
        repo: {
          findById: jest.fn(async () => route),
          findOneWithStops: jest.fn(async () => readModelFor(route)),
        },
      });

      await service.checkInStop(makeCtx(), route.id, route.stops[0].id);
      expect(outboxWriter.publish).toHaveBeenCalledTimes(1);

      // Second call on the SAME already-COMPLETED stop — aggregate
      // returns the existing state (idempotent) and emits no second row.
      await service.checkInStop(makeCtx(), route.id, route.stops[0].id);
      expect(outboxWriter.publish).toHaveBeenCalledTimes(1);
    });

    it('Given a vanished sale (the conditional write classified `missing`), when a stop is checked in, then the service maps it to DeliveryRouteNotFoundError (404 semantics) and the outbox row is NOT published', async () => {
      const route = await makeRoute(['sale-1', 'sale-2'], 'ACTIVE');
      const { service, repo, saleRepo, outboxWriter } = makeService({
        repo: { findById: jest.fn(async () => route) },
        saleRepo: {
          markSaleDelivered: jest.fn(() =>
            Promise.resolve({ kind: 'missing' as const }),
          ),
        },
      });

      const error = await service
        .checkInStop(makeCtx(), route.id, route.stops[0].id)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(DeliveryRouteNotFoundError);
      expect(error).toBeInstanceOf(EntityNotFoundError);
      expect(saleRepo.markSaleDelivered).toHaveBeenCalledTimes(1);
      // The conditional route write is issued first and rolls back with the
      // enclosing transaction when the sale-side outcome aborts it.
      expect(repo.commitTransition).toHaveBeenCalledTimes(1);
      // The tx aborted — no outbox row was committed.
      expect(outboxWriter.publish).not.toHaveBeenCalled();
    });

    it('Given a sale that lost the transition to a concurrent cancellation (`not_deliverable`), when a stop is checked in, then the service throws SaleNotDeliverableError (422) BEFORE the route save and the outbox publish', async () => {
      const route = await makeRoute(['sale-1', 'sale-2'], 'ACTIVE');
      const { service, repo, saleRepo, outboxWriter } = makeService({
        repo: { findById: jest.fn(async () => route) },
        saleRepo: {
          markSaleDelivered: jest.fn(() =>
            Promise.resolve({ kind: 'not_deliverable' as const }),
          ),
        },
      });

      const error = await service
        .checkInStop(makeCtx(), route.id, route.stops[0].id)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(SaleNotDeliverableError);
      expect(error).toBeInstanceOf(BusinessRuleViolationError);
      expect((error as SaleNotDeliverableError).code).toBe(
        'SALE_NOT_DELIVERABLE',
      );
      // The write predicate is tenant-qualified at the call site.
      expect(saleRepo.markSaleDelivered).toHaveBeenCalledWith(
        expect.anything(),
        {
          tenantId: TENANT_ID,
          saleId: 'sale-1',
        },
      );
      // A lost transition aborts before the outbox row; the conditional
      // route write of this attempt rolls back with the transaction.
      expect(repo.commitTransition).toHaveBeenCalledTimes(1);
      expect(outboxWriter.publish).not.toHaveBeenCalled();
    });

    it('Given an already-DELIVERED sale (conditional-write replay), when the stop is checked in, then the service still completes the stop and publishes exactly one next-stop row', async () => {
      const route = await makeRoute(['sale-1', 'sale-2'], 'ACTIVE');
      const { service, repo, saleRepo, outboxWriter } = makeService({
        repo: {
          findById: jest.fn(async () => route),
          findOneWithStops: jest.fn(async () => readModelFor(route)),
        },
        saleRepo: {
          markSaleDelivered: jest.fn(async () => ({
            kind: 'delivered' as const,
          })),
        },
      });

      await service.checkInStop(makeCtx(), route.id, route.stops[0].id);

      expect(route.stops[0].status).toBe('COMPLETED');
      expect(saleRepo.markSaleDelivered).toHaveBeenCalledWith(
        expect.anything(),
        {
          tenantId: TENANT_ID,
          saleId: 'sale-1',
        },
      );
      expect(repo.commitTransition).toHaveBeenCalledTimes(1);
      expect(outboxWriter.publish).toHaveBeenCalledTimes(1);
    });

    it('Given a route missing inside the transaction, when a stop is checked in, then the service throws DeliveryRouteNotFoundError and nothing is persisted', async () => {
      const { service, repo, saleRepo, outboxWriter } = makeService({
        repo: { findById: jest.fn(async () => null) },
      });

      await expect(
        service.checkInStop(makeCtx(), 'missing-route', 'stop-1'),
      ).rejects.toBeInstanceOf(DeliveryRouteNotFoundError);
      expect(saleRepo.markSaleDelivered).not.toHaveBeenCalled();
      expect(repo.commitTransition).not.toHaveBeenCalled();
      expect(outboxWriter.publish).not.toHaveBeenCalled();
    });

    it('Given a DRAFT route, when a stop is checked in, then the service propagates DeliveryRouteInvalidTransitionError (422 semantics)', async () => {
      const route = await makeRoute(['sale-1'], 'DRAFT');
      const { service, repo, outboxWriter } = makeService({
        repo: { findById: jest.fn(async () => route) },
      });

      const error = await service
        .checkInStop(makeCtx(), route.id, route.stops[0].id)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(DeliveryRouteInvalidTransitionError);
      expect(error).toBeInstanceOf(BusinessRuleViolationError);
      expect(repo.commitTransition).not.toHaveBeenCalled();
      expect(outboxWriter.publish).not.toHaveBeenCalled();
    });

    it('Given an ACTIVE route, when the next sale has no customer (null projection), then the outbox row still publishes with `nextCustomerName: null`', async () => {
      const route = await makeRoute(['sale-1', 'sale-2'], 'ACTIVE');
      const projectionMap = new Map<string, ReturnType<typeof saleProjection> | null>();
      projectionMap.set('sale-2', {
        folio: 'F-2',
        customer: null,
        shippingAddress: null,
      });
      const { service, outboxWriter } = makeService({
        repo: {
          findById: jest.fn(async () => route),
          findOneWithStops: jest.fn(async () => readModelFor(route)),
        },
        saleProjectionMap: projectionMap,
      });

      await service.checkInStop(makeCtx(), route.id, route.stops[0].id);

      expect(outboxWriter.publish).toHaveBeenCalledTimes(1);
      const payload = (outboxWriter.publish.mock.calls[0] as unknown[])[5] as {
        nextCustomerName: string | null;
        nextCustomerEmail: string | null;
        nextAddressLabel: string | null;
      };
      expect(payload.nextCustomerName).toBeNull();
      expect(payload.nextCustomerEmail).toBeNull();
      expect(payload.nextAddressLabel).toBeNull();
    });

    it('Given an ACTIVE route, when the next-stop payload is composed, then the next-sale read keeps the exact top-level tenant predicate on the raw tx client and requests nested customer/address tenant ids', async () => {
      const route = await makeRoute(['sale-1', 'sale-2'], 'ACTIVE');
      const { service, txPrisma, outboxWriter } = makeService({
        repo: {
          findById: jest.fn(() => Promise.resolve(route)),
          findOneWithStops: jest.fn(() => Promise.resolve(readModelFor(route))),
        },
      });

      await service.checkInStop(makeCtx(), route.id, route.stops[0].id);

      expect(txPrisma.sale.findFirst).toHaveBeenCalledTimes(1);
      expect(txPrisma.sale.findFirst).toHaveBeenCalledWith({
        where: { id: 'sale-2', tenantId: TENANT_ID },
        select: {
          folio: true,
          customer: {
            select: {
              tenantId: true,
              firstName: true,
              lastName: true,
              email: true,
            },
          },
          shippingAddress: {
            select: {
              tenantId: true,
              label: true,
              street: true,
              exteriorNumber: true,
              interiorNumber: true,
              zipCode: true,
              neighborhood: true,
              municipality: true,
              city: true,
              state: true,
            },
          },
        },
      });
      // The payload read runs on the very same raw transaction client the
      // outbox row is published with (`runInTransaction` merges the empty tx
      // fake with the delegate fake, so deep equality is the identity check).
      expect((outboxWriter.publish.mock.calls[0] as unknown[])[0]).toEqual(
        txPrisma,
      );
    });

    it('Given a tenant-owned next sale whose customer belongs to ANOTHER tenant, when a stop is checked in, then name/email are withheld while the tenant-owned shipping address is still formatted', async () => {
      const route = await makeRoute(['sale-1', 'sale-2'], 'ACTIVE');
      const projectionMap = new Map<
        string,
        ReturnType<typeof saleProjection> | null
      >();
      const foreignCustomerSale = saleProjection('sale-2', {
        customerTenantId: OTHER_TENANT_ID,
      });
      projectionMap.set('sale-2', foreignCustomerSale);
      const { service, outboxWriter } = makeService({
        repo: {
          findById: jest.fn(() => Promise.resolve(route)),
          findOneWithStops: jest.fn(() => Promise.resolve(readModelFor(route))),
        },
        saleProjectionMap: projectionMap,
      });

      await service.checkInStop(makeCtx(), route.id, route.stops[0].id);

      expect(outboxWriter.publish).toHaveBeenCalledTimes(1);
      const payload = (outboxWriter.publish.mock.calls[0] as unknown[])[5] as {
        nextCustomerName: string | null;
        nextCustomerEmail: string | null;
        nextAddressLabel: string | null;
      };
      expect(payload.nextCustomerName).toBeNull();
      expect(payload.nextCustomerEmail).toBeNull();
      expect(payload.nextAddressLabel).toContain('Av. Reforma');
    });

    it('Given a tenant-owned next sale whose shipping address belongs to ANOTHER tenant, when a stop is checked in, then the address label is withheld while the tenant-owned customer name/email are kept', async () => {
      const route = await makeRoute(['sale-1', 'sale-2'], 'ACTIVE');
      const projectionMap = new Map<
        string,
        ReturnType<typeof saleProjection> | null
      >();
      const foreignAddressSale = saleProjection('sale-2', {
        addressTenantId: OTHER_TENANT_ID,
      });
      projectionMap.set('sale-2', foreignAddressSale);
      const { service, outboxWriter } = makeService({
        repo: {
          findById: jest.fn(() => Promise.resolve(route)),
          findOneWithStops: jest.fn(() => Promise.resolve(readModelFor(route))),
        },
        saleProjectionMap: projectionMap,
      });

      await service.checkInStop(makeCtx(), route.id, route.stops[0].id);

      expect(outboxWriter.publish).toHaveBeenCalledTimes(1);
      const payload = (outboxWriter.publish.mock.calls[0] as unknown[])[5] as {
        nextCustomerName: string | null;
        nextCustomerEmail: string | null;
        nextAddressLabel: string | null;
      };
      expect(payload.nextCustomerName).toBe('Ada Lovelace');
      expect(payload.nextCustomerEmail).toBe('sale-2@example.com');
      expect(payload.nextAddressLabel).toBeNull();
    });
  });

  describe('list — driver-only scoping (ADR-5)', () => {
    it('Given a driver-only caller (cannot create DeliveryRoute), when the routes are listed, then the repo is scoped to driverUserId = caller id', async () => {
      const { service, repo } = makeService();
      const can = jest.fn(() => false);
      repo.list.mockResolvedValue([]);

      await service.list(makeCtx(can), {});

      expect(can).toHaveBeenCalledWith('create', 'DeliveryRoute');
      expect(repo.list).toHaveBeenCalledWith({
        tenantId: TENANT_ID,
        driverUserId: USER_ID,
        status: undefined,
      });
    });

    it('Given a route-manager caller (can create DeliveryRoute), when the routes are listed, then the repo receives an unfiltered tenant list', async () => {
      const { service, repo } = makeService();
      repo.list.mockResolvedValue([]);

      await service.list(makeCtx(jest.fn(() => true)), {});

      expect(repo.list).toHaveBeenCalledWith({
        tenantId: TENANT_ID,
        driverUserId: undefined,
        status: undefined,
      });
    });

    it('Given a status query, when the routes are listed, then the status filter is forwarded', async () => {
      const { service, repo } = makeService();
      repo.list.mockResolvedValue([]);

      await service.list(makeCtx(jest.fn(() => false)), { status: 'ACTIVE' });

      expect(repo.list).toHaveBeenCalledWith({
        tenantId: TENANT_ID,
        driverUserId: USER_ID,
        status: ['ACTIVE'],
      });
    });
  });

  describe('start — pre-check vs DB conflict race', () => {
    it('Given an eligible DRAFT route, when it is started, then the route is persisted as ACTIVE with startedAt stamped and activeRouteId armed on every stop', async () => {
      const route = await makeRoute(['sale-1', 'sale-2'], 'DRAFT');
      const { service, repo } = makeService({
        repo: {
          findById: jest.fn(async () => route),
          findOneWithStops: jest.fn(async () => readModelFor(route)),
        },
      });

      const dto = await service.start(makeCtx(), route.id);

      expect(repo.save).toHaveBeenCalledWith(route);
      expect(route.status).toBe('ACTIVE');
      expect(route.startedAt).not.toBeNull();
      expect(route.stops.every((s) => s.activeRouteId === route.id)).toBe(true);
      expect(dto.status).toBe('ACTIVE');
    });

    it('Given a concurrent start race (P2002 on the ADR-7 partial unique index), when the route is started, then the service surfaces DeliveryRouteSaleAlreadyInActiveRouteError (409 domain contract)', async () => {
      const route = await makeRoute(['sale-1'], 'DRAFT');
      const conflictError = new DeliveryRouteSaleAlreadyInActiveRouteError(
        'One or more sales already belong to another active route',
        { reason: 'PARTIAL_UNIQUE_INDEX_VIOLATION', routeId: route.id },
      );
      const { service } = makeService({
        repo: {
          findById: jest.fn(async () => route),
          save: jest.fn(async () => {
            throw conflictError;
          }),
        },
      });

      const error = await service
        .start(makeCtx(), route.id)
        .catch((e: unknown) => e);

      expect(error).toBe(conflictError);
      expect((error as DeliveryRouteSaleAlreadyInActiveRouteError).code).toBe(
        'DELIVERY_ROUTE_STOP_SALE_ALREADY_ON_ACTIVE_ROUTE',
      );
      expect(error).toBeInstanceOf(BusinessRuleViolationError);
    });

    it('Given a route that does not exist, when it is started, then the service throws DeliveryRouteNotFoundError (404 semantics)', async () => {
      const { service } = makeService({
        repo: { findById: jest.fn(async () => null) },
      });

      const error = await service
        .start(makeCtx(), 'missing-route')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(DeliveryRouteNotFoundError);
      expect(error).toBeInstanceOf(EntityNotFoundError);
    });
  });

  describe('getById — timeline assembly (WU3)', () => {
    it('Given an ACTIVE route with two stops (one checked in), when getById is called, then the timeline contains ROUTE_CREATED + ROUTE_STARTED + STOP_CHECKED_IN events in chronological order', async () => {
      const route = await makeRoute(['sale-1', 'sale-2'], 'ACTIVE');
      const later = new Date(NOW.getTime() + 5_000);
      route.stops[0].markCompleted(later);
      const row = readModelFor(route);
      const { service } = makeService({
        repo: {
          findOneWithStops: jest.fn(async () => row),
        },
      });

      const dto = await service.getById(makeCtx(), route.id);

      const types = dto.timeline.map((e: { type: string }) => e.type);
      expect(types).toEqual([
        'ROUTE_CREATED',
        'ROUTE_STARTED',
        'STOP_CHECKED_IN',
      ]);
      // Ascending by `at`.
      const ats = dto.timeline.map((e: { at: string }) => e.at);
      expect(ats).toEqual([...ats].sort());
    });

    it('Given a COMPLETED route, when getById is called, then the timeline ends with ROUTE_COMPLETED', async () => {
      const route = await makeRoute(['sale-1'], 'ACTIVE');
      const later = new Date(NOW.getTime() + 5_000);
      route.stops[0].markCompleted(later);
      // Aggregate auto-completes when the last stop is marked.
      // Trigger the auto-complete by replaying checkInStop semantics via
      // direct mutation for the spec seam.
      // (Aggregate already transitioned to COMPLETED via the markCompleted
      // call when there is only one stop — covered by the entity spec; we
      // verify the read model state here.)
      const row = readModelFor(route);
      // Force the read model to COMPLETED so the timeline builder emits
      // the terminal event.
      const completedRow: DeliveryRouteReadModel = {
        ...row,
        status: 'COMPLETED',
        completedAt: later,
      };
      const { service } = makeService({
        repo: {
          findOneWithStops: jest.fn(async () => completedRow),
        },
      });

      const dto = await service.getById(makeCtx(), route.id);

      const types = dto.timeline.map((e: { type: string }) => e.type);
      expect(types[types.length - 1]).toBe('ROUTE_COMPLETED');
    });

    it('Given a CANCELLED route, when getById is called, then the timeline ends with ROUTE_CANCELLED (not COMPLETED)', async () => {
      const route = await makeRoute(['sale-1'], 'DRAFT');
      route.cancel({ now: NOW });
      const row = readModelFor(route);
      const { service } = makeService({
        repo: {
          findOneWithStops: jest.fn(async () => row),
        },
      });

      const dto = await service.getById(makeCtx(), route.id);

      const types = dto.timeline.map((e: { type: string }) => e.type);
      expect(types).toContain('ROUTE_CANCELLED');
      expect(types).not.toContain('ROUTE_COMPLETED');
    });

    it('Given a missing route, when getById is called, then the service throws DeliveryRouteNotFoundError', async () => {
      const { service } = makeService({
        repo: { findOneWithStops: jest.fn(async () => null) },
      });

      const error = await service
        .getById(makeCtx(), 'missing-route')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(DeliveryRouteNotFoundError);
    });
  });
});

describe('DeliveryRoutesService — concurrent stale-snapshot interleavings (ODD O1)', () => {
  const LATER = new Date(NOW.getTime() + 5_000);

  it('Given two different pending stops racing on an ACTIVE route, when a stale check-in re-evaluates fresh state, then both completions survive in the persisted stop set', async () => {
    const route = await makeRoute(['sale-1', 'sale-2', 'sale-3'], 'ACTIVE');
    const store = new InMemoryDeliveryRouteStore(route);
    const { service } = makeStoreService(store);

    // The competing writer completes stop[0] AFTER this request loaded its
    // snapshot (which still shows stop[0] as PENDING).
    store.interleaveOnce((current) =>
      runCompetingCheckIn(current, route.id, route.stops[0].id, LATER),
    );

    await service.checkInStop(makeCtx(), route.id, route.stops[1].id);

    const persisted = store.persistedRows();
    expect(persisted.stops.map((stop) => stop.status)).toEqual([
      'COMPLETED',
      'COMPLETED',
      'PENDING',
    ]);
    // The winner's completion was NOT overwritten, and the route stays
    // ACTIVE because one pending stop remains.
    expect(persisted.route.status).toBe('ACTIVE');
    expect(persisted.stops.map((stop) => stop.completedAt === null)).toEqual([
      false,
      false,
      true,
    ]);
    // One next-stop row per completed stop, each under its own idempotency key.
    expect(store.outboxRows.map((row) => row.idempotencyKey)).toEqual([
      `${TENANT_ID}:${route.stops[0].id}`,
      `${TENANT_ID}:${route.stops[1].id}`,
    ]);
    // The stale attempt was re-evaluated against freshly persisted state.
    expect(store.commitAttempts).toBeGreaterThan(1);
  });

  it('Given a concurrent duplicate check-in of the SAME stop, when the losing request replays, then it succeeds idempotently and writes no second next-stop outbox row', async () => {
    const route = await makeRoute(['sale-1', 'sale-2'], 'ACTIVE');
    const store = new InMemoryDeliveryRouteStore(route);
    const { service } = makeStoreService(store);

    store.interleaveOnce((current) =>
      runCompetingCheckIn(current, route.id, route.stops[0].id, LATER),
    );

    const dto = await service.checkInStop(
      makeCtx(),
      route.id,
      route.stops[0].id,
    );

    // Successful replay — no 422/409, the stop is COMPLETED exactly once.
    expect(dto.stops.map((stop) => stop.status)).toEqual([
      'COMPLETED',
      'PENDING',
    ]);
    const persisted = store.persistedRows();
    expect(persisted.stops.map((stop) => stop.status)).toEqual([
      'COMPLETED',
      'PENDING',
    ]);
    // Exactly ONE persistent side effect for one stop transition: the
    // winner's row. The replay must not append a duplicate.
    expect(store.outboxKeysFor(route.stops[0].id)).toEqual([
      `${TENANT_ID}:${route.stops[0].id}`,
    ]);
  });

  it('Given a cancellation that already won, when the stale check-in re-evaluates, then it fails with DELIVERY_ROUTE_INVALID_TRANSITION (422) before any sale, route, stop or outbox write', async () => {
    const route = await makeRoute(['sale-1', 'sale-2'], 'ACTIVE');
    const store = new InMemoryDeliveryRouteStore(route);
    const { service, saleRepo } = makeStoreService(store);

    store.interleaveOnce((current) =>
      runCompetingCancel(current, route.id, LATER),
    );

    const error = await service
      .checkInStop(makeCtx(), route.id, route.stops[0].id)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DeliveryRouteInvalidTransitionError);
    expect((error as BusinessRuleViolationError).code).toBe(
      'DELIVERY_ROUTE_INVALID_TRANSITION',
    );
    // The 422 landed before the sale mirror flip and before every route,
    // stop and outbox write.
    expect(saleRepo.markSaleDelivered).not.toHaveBeenCalled();
    expect(store.outboxRows).toHaveLength(0);
    const persisted = store.persistedRows();
    expect(persisted.route.status).toBe('CANCELLED');
    expect(persisted.route.cancelledAt).toEqual(LATER);
    expect(persisted.stops.map((stop) => stop.status)).toEqual([
      'PENDING',
      'PENDING',
    ]);
    expect(persisted.stops.every((stop) => stop.activeRouteId === null)).toBe(
      true,
    );
  });

  it('Given two concurrent final pending stops, when their check-ins interleave, then auto-completion is decided from persisted stop state and the route never stays ACTIVE with zero pending stops', async () => {
    const route = await makeRoute(['sale-1', 'sale-2'], 'ACTIVE');
    const store = new InMemoryDeliveryRouteStore(route);
    const { service } = makeStoreService(store);

    store.interleaveOnce((current) =>
      runCompetingCheckIn(current, route.id, route.stops[0].id, LATER),
    );

    await service.checkInStop(makeCtx(), route.id, route.stops[1].id);

    const persisted = store.persistedRows();
    expect(persisted.stops.map((stop) => stop.status)).toEqual([
      'COMPLETED',
      'COMPLETED',
    ]);
    expect(persisted.route.status).toBe('COMPLETED');
    expect(persisted.route.completedAt).not.toBeNull();
    // ADR-7 markers are cleared once the route leaves ACTIVE.
    expect(persisted.stops.every((stop) => stop.activeRouteId === null)).toBe(
      true,
    );
  });

  it('Given a non-final check-in that won first, when a valid cancellation re-evaluates, then it proceeds without reverting the completed stop', async () => {
    const route = await makeRoute(['sale-1', 'sale-2', 'sale-3'], 'ACTIVE');
    const store = new InMemoryDeliveryRouteStore(route);
    const { service } = makeStoreService(store);
    const winningCheckInAt = new Date(NOW.getTime() + 3_000);

    // The cancellation request loaded its snapshot before the check-in won.
    store.interleaveOnce((current) =>
      runCompetingCheckIn(
        current,
        route.id,
        route.stops[0].id,
        winningCheckInAt,
      ),
    );

    const dto = await service.cancel(makeCtx(), route.id);

    const persisted = store.persistedRows();
    expect(dto.status).toBe('CANCELLED');
    expect(persisted.route.status).toBe('CANCELLED');
    const completed = persisted.stops.find(
      (stop) => stop.id === route.stops[0].id,
    );
    expect(completed?.status).toBe('COMPLETED');
    expect(completed?.completedAt).toEqual(winningCheckInAt);
    expect(completed?.checkedInAt).toEqual(winningCheckInAt);
    expect(persisted.stops.every((stop) => stop.activeRouteId === null)).toBe(
      true,
    );
    expect(
      persisted.stops.filter((stop) => stop.status === 'PENDING'),
    ).toHaveLength(2);
  });

  it('Given a snapshot that loses every attempt, when the retry budget is exhausted, then the transition fails with DELIVERY_ROUTE_INVALID_TRANSITION instead of reporting a false success', async () => {
    const route = await makeRoute(['sale-1', 'sale-2'], 'ACTIVE');
    const store = new InMemoryDeliveryRouteStore(route);
    const { service } = makeStoreService(store);
    store.forceStaleCommits = true;

    const error = await service
      .checkInStop(makeCtx(), route.id, route.stops[0].id)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DeliveryRouteInvalidTransitionError);
    expect((error as BusinessRuleViolationError).code).toBe(
      'DELIVERY_ROUTE_INVALID_TRANSITION',
    );
    // Bounded: more than one attempt, and a finite budget — not a silent
    // success and not an unbounded loop.
    expect(store.commitAttempts).toBeGreaterThan(1);
    expect(store.commitAttempts).toBeLessThan(10);
    // Every losing attempt rolled back: no stop completion, no outbox row.
    const persisted = store.persistedRows();
    expect(persisted.route.status).toBe('ACTIVE');
    expect(persisted.stops.map((stop) => stop.status)).toEqual([
      'PENDING',
      'PENDING',
    ]);
    expect(store.outboxRows).toHaveLength(0);
  });
});
