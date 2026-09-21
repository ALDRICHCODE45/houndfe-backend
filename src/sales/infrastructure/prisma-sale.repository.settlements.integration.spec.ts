/**
 * settleRefund invariants (rfs-2b) on real Postgres: ordered immutable
 * ledger, cross-tenant isolation, deterministic `FOR UPDATE` contention,
 * and idempotent replay.
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { ClsService } from 'nestjs-cls';
import {
  BASELINE_TENANT_ID,
  disconnectIntegrationPrisma,
  resetAndSeedBaseline,
} from '../../../test/integration/reset-db';
import type {
  RefundSettlementResult,
  SettleRefundInput,
} from '../domain/sale.repository';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { PrismaSaleRepository } from './prisma-sale.repository';

const SKIP_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const describeIfDb = SKIP_INTEGRATION ? describe.skip : describe;
const POLL_DEADLINE_MS = 5000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Concurrency-safe outcome: never read a rejected promise's result. */
type SettleOutcome =
  | { kind: 'ok'; result: RefundSettlementResult }
  | { kind: 'error'; code: string };

const errorCode = (error: unknown): string => {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return String((error as { code?: unknown }).code);
  }
  return 'UNKNOWN_ERROR';
};

describeIfDb(
  'PrismaSaleRepository settleRefund invariants (Integration - Real DB)',
  () => {
    let prisma: PrismaClient;
    let tenantId: string;

    beforeAll(async () => {
      prisma = new PrismaClient();
      await prisma.$connect();
      await resetAndSeedBaseline();
      const tenant = await prisma.tenant.findFirst({ select: { id: true } });
      if (!tenant) {
        throw new Error('No tenant found; verify .env.test + `test:db:up`.');
      }
      tenantId = tenant.id;
      expect(tenantId).toBe(BASELINE_TENANT_ID);
    });

    afterEach(async () => {
      await resetAndSeedBaseline();
    });

    afterAll(async () => {
      await prisma.$disconnect();
      await disconnectIntegrationPrisma();
    });

    function createHarness() {
      const store = new Map<string, unknown>([
        ['tenantId', tenantId],
        ['isSuperAdmin', false],
      ]);
      const cls = {
        get: (key: string) => store.get(key),
        set: (key: string, value: unknown) => {
          store.set(key, value);
        },
      } as unknown as ClsService<TenantClsStore>;
      const tenantPrisma = new TenantPrismaService(
        prisma as unknown as ConstructorParameters<
          typeof TenantPrismaService
        >[0],
        cls,
      );
      return { repo: new PrismaSaleRepository(tenantPrisma), tenantPrisma };
    }

    async function seedUser(): Promise<string> {
      const id = randomUUID();
      await prisma.user.create({
        data: {
          id,
          email: `cashier-${randomUUID()}@test.local`,
          hashedPassword: 'test',
          name: 'Cashier',
          isActive: true,
        },
      });
      return id;
    }

    async function seedForeignTenant(): Promise<string> {
      const id = randomUUID();
      await prisma.tenant.create({
        data: {
          id,
          name: 'Foreign Tenant',
          slug: `foreign-${randomUUID()}`,
          isActive: true,
        },
      });
      return id;
    }

    async function seedPendingRefund(
      ownerTenantId: string,
      amountCents: number,
    ): Promise<{ refundId: string; saleId: string }> {
      const userId = await seedUser();
      const saleId = randomUUID();
      await prisma.sale.create({
        data: {
          id: saleId,
          userId,
          tenantId: ownerTenantId,
          status: 'CONFIRMED',
          channel: 'ONLINE',
        },
      });
      const refundId = randomUUID();
      await prisma.saleRefund.create({
        data: {
          id: refundId,
          tenantId: ownerTenantId,
          saleId,
          salePaymentId: null,
          method: 'CASH',
          amountCents,
          settledCents: 0,
          reason: 'CUSTOMER_REQUEST',
          status: 'PENDING',
          createdAt: new Date('2026-07-01T08:00:00.000Z'),
        },
      });
      return { refundId, saleId };
    }

    const settlementInput = (
      refundId: string,
      overrides: Partial<SettleRefundInput> = {},
    ): SettleRefundInput => ({
      refundId,
      settledByUserId: null,
      amountCents: 0,
      method: 'cash',
      reference: null,
      settledAt: new Date('2026-07-02T09:30:00.000Z'),
      ...overrides,
    });

    async function ledgerRows(refundId: string) {
      return prisma.saleRefundSettlement.findMany({
        where: { saleRefundId: refundId, tenantId },
        orderBy: [{ settledAt: 'asc' }, { id: 'asc' }],
      });
    }

    /** Polls until a backend is blocked on the refund row `FOR UPDATE` lock,
     * so the contention proof never depends on promise start ordering. */
    async function waitForRefundLock(): Promise<boolean> {
      const deadline = Date.now() + POLL_DEADLINE_MS;
      while (Date.now() < deadline) {
        const waiting = await prisma.$queryRaw<Array<{ blocked: boolean }>>`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity waiter
            WHERE waiter.wait_event_type = 'Lock'
              AND waiter.query ILIKE '%FOR UPDATE%'
              AND waiter.query ILIKE '%sale_refunds%'
              AND cardinality(pg_blocking_pids(waiter.pid)) > 0
          ) AS blocked
        `;
        if (waiting[0]?.blocked) return true;
        await sleep(25);
      }
      return false;
    }

    it('appends a partial then the exact remainder, ordered and immutable', async () => {
      const { refundId } = await seedPendingRefund(tenantId, 1000);
      const firstActor = await seedUser();
      const secondActor = await seedUser();
      const { repo, tenantPrisma } = createHarness();
      const first = await tenantPrisma.runInTransaction(() =>
        repo.settleRefund(
          settlementInput(refundId, {
            settledByUserId: firstActor,
            amountCents: 300,
            reference: 'AUTH-300',
          }),
        ),
      );
      expect(first.saleId).toEqual(expect.any(String));
      expect(first).toMatchObject({ settledCents: 300, outstandingCents: 700 });
      await expect(
        repo.findManyPendingRefunds({ page: 1, limit: 10 }),
      ).resolves.toEqual([
        expect.objectContaining({
          id: refundId,
          amountCents: 1000,
          settledCents: 300,
          outstandingCents: 700,
        }),
      ]);
      await expect(repo.countPendingRefunds()).resolves.toBe(1);
      const firstRowSnapshot = (await ledgerRows(refundId))[0];
      expect(firstRowSnapshot).toMatchObject({
        amountCents: 300,
        method: 'CASH',
        reference: 'AUTH-300',
        settledByUserId: firstActor,
        settledAt: new Date('2026-07-02T09:30:00.000Z'),
      });
      const second = await tenantPrisma.runInTransaction(() =>
        repo.settleRefund(
          settlementInput(refundId, {
            settledByUserId: secondActor,
            amountCents: 700,
            method: 'card_credit',
            reference: 'AUTH-700',
            settledAt: new Date('2026-07-03T11:00:00.000Z'),
          }),
        ),
      );
      expect(second).toMatchObject({ settledCents: 1000, outstandingCents: 0 });
      await expect(
        repo.findManyPendingRefunds({ page: 1, limit: 10 }),
      ).resolves.toEqual([]);
      await expect(repo.countPendingRefunds()).resolves.toBe(0);
      const obligation = await prisma.saleRefund.findUnique({
        where: { id: refundId },
        select: { amountCents: true, settledCents: true },
      });
      expect(obligation).toEqual({ amountCents: 1000, settledCents: 1000 });
      const rows = await ledgerRows(refundId);
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.amountCents)).toEqual([300, 700]);
      expect(rows[0]).toEqual(firstRowSnapshot);
      expect(rows[1]).toMatchObject({
        amountCents: 700,
        method: 'CARD_CREDIT',
        reference: 'AUTH-700',
        settledByUserId: secondActor,
        settledAt: new Date('2026-07-03T11:00:00.000Z'),
      });
    });

    it('returns REFUND_NOT_FOUND for a foreign refund and leaves it untouched', async () => {
      const foreignTenantId = await seedForeignTenant();
      const { refundId } = await seedPendingRefund(foreignTenantId, 1000);
      const { repo, tenantPrisma } = createHarness();
      await expect(
        tenantPrisma.runInTransaction(() =>
          repo.settleRefund(settlementInput(refundId, { amountCents: 1000 })),
        ),
      ).rejects.toMatchObject({ code: 'REFUND_NOT_FOUND' });
      const foreignObligation = await prisma.saleRefund.findUnique({
        where: { id: refundId },
        select: { settledCents: true },
      });
      expect(foreignObligation).toEqual({ settledCents: 0 });
      await expect(
        prisma.saleRefundSettlement.count({
          where: { saleRefundId: refundId },
        }),
      ).resolves.toBe(0);
    });

    it('serializes two concurrent settles into one append and one rejection', async () => {
      const { refundId } = await seedPendingRefund(tenantId, 1000);
      const actor = await seedUser();
      const first = createHarness();
      const second = createHarness();
      const input = settlementInput(refundId, {
        settledByUserId: actor,
        amountCents: 700,
        method: 'transfer',
        reference: 'CONCURRENT-700',
        settledAt: new Date('2026-07-04T12:00:00.000Z'),
      });
      const settle = (
        harness: ReturnType<typeof createHarness>,
        afterWrite?: () => Promise<void>,
      ): Promise<SettleOutcome> =>
        harness.tenantPrisma
          .runInTransaction(async () => {
            const result = await harness.repo.settleRefund(input);
            if (afterWrite) await afterWrite();
            return result;
          })
          .then(
            (result): SettleOutcome => ({ kind: 'ok', result }),
            (error: unknown): SettleOutcome => ({
              kind: 'error',
              code: errorCode(error),
            }),
          );
      let written!: () => void;
      let releaseLock!: () => void;
      const writeDone = new Promise<void>((resolve) => (written = resolve));
      const lockHeld = new Promise<void>((resolve) => (releaseLock = resolve));

      const firstOutcome = settle(first, async () => {
        written();
        await lockHeld;
      });
      await writeDone;

      const secondOutcome = settle(second);
      try {
        expect(await waitForRefundLock()).toBe(true);
      } finally {
        releaseLock();
      }

      const outcomes = await Promise.all([firstOutcome, secondOutcome]);
      const succeeded = outcomes.filter(
        (outcome): outcome is { kind: 'ok'; result: RefundSettlementResult } =>
          outcome.kind === 'ok',
      );
      const rejected = outcomes.filter(
        (outcome): outcome is { kind: 'error'; code: string } =>
          outcome.kind === 'error',
      );
      expect(succeeded).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(succeeded[0].result).toMatchObject({
        settledCents: 700,
        outstandingCents: 300,
      });
      expect(rejected[0].code).toBe('SETTLEMENT_EXCEEDS_REFUND');

      const rows = await ledgerRows(refundId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.amountCents).toBe(700);
      const obligation = await prisma.saleRefund.findUnique({
        where: { id: refundId },
        select: { settledCents: true },
      });
      expect(obligation).toEqual({ settledCents: 700 });
    });

    it('replays the idempotency slot without a second ledger append', async () => {
      const { refundId } = await seedPendingRefund(tenantId, 1000);
      const actor = await seedUser();
      const { repo, tenantPrisma } = createHarness();
      const key = 'settle-key-rfs-2b';
      const hash = 'settle-hash-rfs-2b';
      const slot = await repo.acquireSettlementIdempotency(refundId, key, hash);
      expect(slot.kind).toBe('acquired');
      if (slot.kind !== 'acquired') {
        throw new Error('expected an acquired idempotency slot');
      }
      const savedPayload = await tenantPrisma.runInTransaction(async () => {
        const result = await repo.settleRefund(
          settlementInput(refundId, {
            settledByUserId: actor,
            amountCents: 1000,
            method: 'cash',
            reference: 'AUTH-IDEMPOTENT',
            settledAt: new Date('2026-07-05T10:00:00.000Z'),
          }),
        );
        const payload = {
          settlementId: result.settlementId,
          settledCents: result.settledCents,
        };
        await repo.markSettlementIdempotencySucceeded(
          slot.token,
          result.saleId,
          payload,
        );
        return payload;
      });

      const replay = await repo.acquireSettlementIdempotency(
        refundId,
        key,
        hash,
      );
      expect(replay).toEqual({ kind: 'replay', payload: savedPayload });
      await expect(ledgerRows(refundId)).resolves.toHaveLength(1);
      const obligation = await prisma.saleRefund.findUnique({
        where: { id: refundId },
        select: { settledCents: true },
      });
      expect(obligation).toEqual({ settledCents: 1000 });
    });
  },
);
