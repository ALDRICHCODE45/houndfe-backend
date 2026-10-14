import { createHash } from 'crypto';
import { SalesService } from './sales.service';
import type {
  ISaleRepository,
  SaleRefundMethod,
} from './domain/sale.repository';
import { Sale } from './domain/sale.entity';
import { BusinessRuleViolationError } from '../shared/domain/domain-error';
import type { ProductsService } from '../products/products.service';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { OutboxWriterService } from '../shared/outbox/outbox-writer.service';
import type { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import type { ISaleCommentRepository } from './comments/domain/sale-comment.repository';
import type { IPromotionUsageRepository } from '../promotions/domain/promotion-usage.repository';
import type { ICashLedger } from '../cash-register/cash-ledger.port';

/**
 * Cash-register closing / T4 — public SalesService contract for the optional
 * `cashSessionId` binding.
 *
 * The fake `TenantPrismaService.runInTransaction` opens an ambient transaction
 * and the repository's `runInTransaction` joins it, mirroring the production
 * CLS behavior. All writes are asserted to observe `getClient()`'s ambient
 * client. A mocked transaction cannot prove PostgreSQL rollback; the tests
 * only prove the ordering and the fact that every write shares the one
 * wrapper transaction.
 */

const ACTOR = 'user-1';
const SESSION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PM_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const REFUND_ID = '11111111-1111-4111-8111-111111111111';
const SALE_ID = '22222222-2222-4222-8222-222222222222';
const SETTLEMENT_ID = '44444444-4444-4444-8444-444444444444';
const SETTLED_AT = '2026-07-01T10:30:00.000Z';

const sha256 = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

type RepoMock = ReturnType<typeof makeRepoMock>;
type LedgerMock = ReturnType<typeof makeLedgerMock>;

function makeLedgerMock() {
  return {
    assertOpenSession: jest.fn((): Promise<void> => Promise.resolve()),
    recordPayments: jest.fn((input: unknown): Promise<void> => {
      void input;
      return Promise.resolve();
    }),
    recordRefund: jest.fn((): Promise<void> => Promise.resolve()),
  };
}

function makeRepoMock() {
  return {
    findByIdForUpdate: jest.fn(
      (): Promise<Sale | null> => Promise.resolve(null),
    ),
    runInTransaction: jest.fn(),
    acquireChargeIdempotency: jest.fn(),
    markChargeIdempotencySucceeded: jest.fn(
      (): Promise<void> => Promise.resolve(),
    ),
    acquirePaymentIdempotency: jest.fn(),
    markPaymentIdempotencySucceeded: jest.fn(
      (): Promise<void> => Promise.resolve(),
    ),
    acquireSettlementIdempotency: jest.fn(),
    releaseSettlementIdempotency: jest.fn(
      (): Promise<void> => Promise.resolve(),
    ),
    markSettlementIdempotencySucceeded: jest.fn(
      (): Promise<void> => Promise.resolve(),
    ),
    settleRefund: jest.fn(),
    allocateNextFolio: jest.fn((): Promise<string> => Promise.resolve('A-1')),
    persistChargeConfirmation: jest.fn(
      (): Promise<unknown[]> => Promise.resolve([]),
    ),
    persistCollectedPayments: jest.fn(),
  };
}

function buildHarness(options: { withoutLedger?: boolean } = {}) {
  const events: string[] = [];
  let ambientDepth = 0;
  let openedTransactions = 0;

  const record = (name: string): void => {
    events.push(`${name}@${ambientDepth > 0 ? 'tx' : 'out'}`);
  };

  const ledger: LedgerMock = makeLedgerMock();
  ledger.assertOpenSession.mockImplementation(() => {
    record('assert:open');
    return Promise.resolve();
  });
  ledger.recordPayments.mockImplementation(() => {
    record('record:payments');
    return Promise.resolve();
  });
  ledger.recordRefund.mockImplementation(() => {
    record('record:refund');
    return Promise.resolve();
  });

  const tenantPrismaRunInTransaction = jest.fn(
    async (work: () => Promise<unknown>): Promise<unknown> => {
      if (ambientDepth > 0) {
        events.push('tx:join');
        return work();
      }
      openedTransactions += 1;
      ambientDepth += 1;
      events.push('tx:open');
      try {
        return await work();
      } finally {
        ambientDepth -= 1;
        events.push('tx:close');
      }
    },
  );

  const tenantPrisma = {
    getTenantId: jest.fn(() => 'tenant-1'),
    getClient: jest.fn(
      () =>
        ({
          globalPriceList: {
            findFirst: jest.fn().mockResolvedValue({ id: 'gpl-1' }),
          },
        }) as never,
    ),
    isInTransaction: jest.fn(() => ambientDepth > 0),
    runInTransaction: tenantPrismaRunInTransaction,
  } as unknown as TenantPrismaService;

  const saleRepo: RepoMock = makeRepoMock();
  saleRepo.runInTransaction.mockImplementation((work: () => Promise<unknown>) =>
    tenantPrismaRunInTransaction(work),
  );
  saleRepo.findByIdForUpdate.mockImplementation(() => {
    record('lock:sale');
    return Promise.resolve(null);
  });
  saleRepo.acquireChargeIdempotency.mockImplementation(() => {
    record('acquire:charge');
    return Promise.resolve({ kind: 'acquired', token: 'charge-token' });
  });
  saleRepo.acquirePaymentIdempotency.mockImplementation(() => {
    record('acquire:payment');
    return Promise.resolve({ kind: 'acquired', token: 'payment-token' });
  });
  saleRepo.acquireSettlementIdempotency.mockImplementation(() => {
    record('acquire:settle');
    return Promise.resolve({ kind: 'acquired', token: 'settle-token' });
  });
  saleRepo.markChargeIdempotencySucceeded.mockImplementation(() => {
    record('mark:charge');
    return Promise.resolve();
  });
  saleRepo.allocateNextFolio.mockImplementation(() => {
    record('folio');
    return Promise.resolve('A-1');
  });
  saleRepo.persistChargeConfirmation.mockImplementation(() => {
    record('persist:charge');
    return Promise.resolve([]);
  });
  saleRepo.persistCollectedPayments.mockImplementation(() => {
    record('persist:payments');
    return Promise.resolve({
      paymentIds: ['payment-1'],
      paidCents: 0,
      debtCents: 0,
      paymentStatus: 'PAID',
      totalCents: 0,
    });
  });
  saleRepo.settleRefund.mockImplementation(() => {
    record('settle:refund');
    return Promise.resolve({
      settlementId: SETTLEMENT_ID,
      saleId: SALE_ID,
      settledCents: 2500,
      outstandingCents: 0,
    });
  });
  saleRepo.markSettlementIdempotencySucceeded.mockImplementation(() => {
    record('mark:settle');
    return Promise.resolve();
  });

  const products = {
    getProductInfoForSale: jest.fn(
      (): Promise<{ unitPriceCents: number }> =>
        Promise.resolve({ unitPriceCents: 1000 }),
    ),
    checkStockAvailability: jest.fn(),
    getApplicablePrices: jest.fn(),
    resolveListPrice: jest.fn(),
    resolvePriceListGlobalIds: jest.fn(
      (): Promise<Map<string, string>> => Promise.resolve(new Map()),
    ),
    resolveProductCategoryBrandIds: jest.fn(
      (): Promise<Map<string, unknown>> => Promise.resolve(new Map()),
    ),
    batchResolvePriceMap: jest.fn(
      (): Promise<Map<string, Map<number, number>>> =>
        Promise.resolve(new Map()),
    ),
    decrementStockForCharge: jest.fn((): Promise<unknown[]> => {
      record('stock');
      return Promise.resolve([]);
    }),
    incrementStockForRestock: jest.fn((): Promise<void> => Promise.resolve()),
  };

  const eventEmitter = { emit: jest.fn() };
  const outboxWriter = {
    publish: jest.fn((): Promise<void> => Promise.resolve()),
  };
  const saleCommentRepo = {
    findActiveBySale: jest.fn((): Promise<unknown[]> => Promise.resolve([])),
  };
  const posEvaluate = {
    evaluate: jest.fn(
      (): Promise<unknown> =>
        Promise.resolve({
          lines: [],
          order: null,
          availableManualPromotions: [],
          targetableManualPromotionIds: [],
          promotionCapacityDemands: [],
          capacityExcludedPromotionIds: [],
        }),
    ),
  };
  const paymentMethodResolver = {
    resolveActive: jest.fn(
      (): Promise<unknown> =>
        Promise.resolve({
          category: 'cash',
          name: 'Test Method',
          subtitle: null,
        }),
    ),
    listActive: jest.fn((): Promise<unknown[]> => Promise.resolve([])),
  };
  const promotionUsageRepo = {
    claimForSale: jest.fn((): Promise<void> => Promise.resolve()),
    restoreForSale: jest.fn((): Promise<void> => Promise.resolve()),
  };

  const service = new SalesService(
    saleRepo as unknown as ISaleRepository,
    products as unknown as ProductsService,
    eventEmitter as unknown as EventEmitter2,
    outboxWriter as unknown as OutboxWriterService,
    tenantPrisma,
    saleCommentRepo as unknown as Pick<
      ISaleCommentRepository,
      'findActiveBySale'
    >,
    posEvaluate as never,
    paymentMethodResolver as never,
    promotionUsageRepo as unknown as IPromotionUsageRepository,
    options.withoutLedger ? undefined : (ledger as unknown as ICashLedger),
  );

  const lockSale = (sale: Sale): void => {
    saleRepo.findByIdForUpdate.mockImplementation(() => {
      record('lock:sale');
      return Promise.resolve(sale);
    });
  };

  return {
    service,
    saleRepo,
    products,
    events,
    ledger,
    record,
    lockSale,
    opened: () => openedTransactions,
  };
}

const buildDraftSale = (id: string, unitPriceCents: number): Sale =>
  Sale.fromPersistence({
    id,
    userId: ACTOR,
    customerId: 'customer-1',
    status: 'DRAFT',
    createdAt: new Date(),
    updatedAt: new Date(),
    items: [
      {
        id: `${id}-item-1`,
        saleId: id,
        productId: 'prod-1',
        variantId: null,
        productName: 'Prod 1',
        variantName: null,
        quantity: 1,
        unitPriceCents,
        unitPriceCurrency: 'MXN',
      },
    ],
  });

const buildConfirmedSale = (id: string, totalCents: number): Sale =>
  Sale.fromPersistence({
    id,
    userId: ACTOR,
    customerId: 'customer-1',
    status: 'CONFIRMED',
    createdAt: new Date(),
    updatedAt: new Date(),
    items: [
      {
        id: `${id}-item-1`,
        saleId: id,
        productId: 'prod-1',
        variantId: null,
        productName: 'Prod 1',
        variantName: null,
        quantity: 1,
        unitPriceCents: totalCents,
        unitPriceCurrency: 'MXN',
      },
    ],
  });

const setupChargeSale = (h: ReturnType<typeof buildHarness>, sale: Sale) => {
  h.lockSale(sale);
  h.products.getProductInfoForSale.mockResolvedValue({
    unitPriceCents: sale.items[0].unitPriceCents,
  });
  h.saleRepo.persistChargeConfirmation.mockResolvedValue([
    {
      paymentId: 'pmt-1',
      method: 'cash',
      amountCents: 0,
      reference: null,
    },
  ]);
};

const refundDto = (
  overrides: Partial<{
    amountCents: number;
    method: SaleRefundMethod;
    reference: string;
    settledAt: string;
    cashSessionId: string;
  }> = {},
) => ({
  amountCents: 2500,
  method: 'cash' as SaleRefundMethod,
  reference: 'R-1',
  settledAt: SETTLED_AT,
  ...overrides,
});

describe('SalesService — cash session binding (T4)', () => {
  describe('chargeDraft', () => {
    it('keeps the unbound legacy path: acquire before any transaction, no fence, no ledger', async () => {
      const h = buildHarness();
      const sale = buildDraftSale('sale-legacy', 1000);
      setupChargeSale(h, sale);

      await h.service.chargeDraft(
        sale.id,
        ACTOR,
        { method: 'cash', amountCents: 1000 },
        'key-legacy',
      );

      expect(h.events[0]).toBe('acquire:charge@out');
      expect(h.events).toContain('tx:open');
      expect(h.events).not.toContain('assert:open@tx');
      expect(h.events).not.toContain('record:payments@tx');
      expect(h.ledger.assertOpenSession).not.toHaveBeenCalled();
      expect(h.ledger.recordPayments).not.toHaveBeenCalled();
    });

    it('wraps the idempotency acquire in the ambient transaction for a bound charge', async () => {
      const h = buildHarness();
      const sale = buildDraftSale('sale-bound', 1000);
      setupChargeSale(h, sale);

      await h.service.chargeDraft(
        sale.id,
        ACTOR,
        { method: 'cash', amountCents: 1000, cashSessionId: SESSION_A },
        'key-bound',
      );

      expect(h.events[0]).toBe('tx:open');
      expect(h.events).toContain('acquire:charge@tx');
      expect(h.events).toContain('assert:open@tx');
      expect(h.events).toContain('tx:join');
      expect(h.opened()).toBe(1);
    });

    it('replays a completed bound charge without re-asserting the OPEN fence', async () => {
      const h = buildHarness();
      const payload = {
        saleId: SALE_ID,
        folio: 'A-1',
        subtotalCents: 1000,
        discountCents: 0,
        totalCents: 1000,
        paidCents: 1000,
        debtCents: 0,
        changeDueCents: 0,
        paymentStatus: 'PAID' as const,
        confirmedAt: new Date().toISOString(),
      };
      h.saleRepo.acquireChargeIdempotency.mockResolvedValue({
        kind: 'replay',
        payload,
      });

      const result = await h.service.chargeDraft(
        SALE_ID,
        ACTOR,
        { method: 'cash', amountCents: 1000, cashSessionId: SESSION_A },
        'key-replay',
      );

      expect(result).toEqual(payload);
      expect(h.ledger.assertOpenSession).not.toHaveBeenCalled();
      expect(h.saleRepo.findByIdForUpdate).not.toHaveBeenCalled();
    });

    it('fences the session before the sale lock and writes nothing when the fence rejects', async () => {
      const h = buildHarness();
      const sale = buildDraftSale('sale-fence', 1000);
      setupChargeSale(h, sale);
      h.ledger.assertOpenSession.mockImplementationOnce(() => {
        h.record('assert:open');
        throw new BusinessRuleViolationError(
          'CASH_SESSION_NOT_OPEN',
          'CASH_SESSION_NOT_OPEN',
        );
      });

      await expect(
        h.service.chargeDraft(
          sale.id,
          ACTOR,
          { method: 'cash', amountCents: 1000, cashSessionId: SESSION_A },
          'key-fence',
        ),
      ).rejects.toThrow('CASH_SESSION_NOT_OPEN');

      expect(h.events).toContain('assert:open@tx');
      expect(h.events).not.toContain('lock:sale@tx');
      expect(h.products.decrementStockForCharge).not.toHaveBeenCalled();
      expect(h.saleRepo.allocateNextFolio).not.toHaveBeenCalled();
      expect(h.saleRepo.persistChargeConfirmation).not.toHaveBeenCalled();
      expect(h.saleRepo.markChargeIdempotencySucceeded).not.toHaveBeenCalled();
      expect(h.ledger.recordPayments).not.toHaveBeenCalled();
      // The acquire ran inside the wrapper transaction, so a rejected fence
      // rolls the freshly created idempotency row back with the writes.
      expect(h.events).toContain('acquire:charge@tx');
      expect(h.opened()).toBe(1);
    });

    it('records the created payment IDs and the sale change exactly once (50000 tender / 15000 change)', async () => {
      const h = buildHarness();
      const sale = buildDraftSale('sale-change', 35000);
      setupChargeSale(h, sale);
      h.saleRepo.persistChargeConfirmation.mockResolvedValue([
        {
          paymentId: 'pmt-cash',
          method: 'cash',
          amountCents: 50000,
          reference: null,
        },
      ]);

      const result = await h.service.chargeDraft(
        sale.id,
        ACTOR,
        {
          payments: [{ method: 'cash', amountCents: 50000 }],
          cashSessionId: SESSION_A,
        },
        'key-change',
      );

      expect(result.totalCents).toBe(35000);
      expect(result.changeDueCents).toBe(15000);
      expect(h.ledger.recordPayments).toHaveBeenCalledTimes(1);
      expect(h.ledger.recordPayments).toHaveBeenCalledWith({
        sessionId: SESSION_A,
        actorId: ACTOR,
        saleId: sale.id,
        payments: [
          {
            paymentId: 'pmt-cash',
            method: 'cash',
            amountCents: 50000,
            metadataJson: undefined,
          },
        ],
        changeDueCents: 15000,
        occurredAt: expect.any(Date) as unknown,
      });
    });

    it('preserves canonical payment order and resolved catalog metadata for the ledger', async () => {
      const h = buildHarness();
      const sale = buildDraftSale('sale-order', 35000);
      setupChargeSale(h, sale);
      h.products.getProductInfoForSale.mockResolvedValue({
        unitPriceCents: 35000,
      });
      const resolver = (
        h.service as unknown as { paymentMethodResolver: unknown }
      ).paymentMethodResolver as {
        resolveActive: jest.Mock;
      };
      resolver.resolveActive.mockResolvedValue({
        category: 'cash',
        name: 'Efectivo',
        subtitle: 'Caja',
      });
      h.saleRepo.persistChargeConfirmation.mockResolvedValue([
        {
          paymentId: 'pmt-cash',
          method: 'cash',
          amountCents: 10000,
          reference: null,
        },
        {
          paymentId: 'pmt-card',
          method: 'card_debit',
          amountCents: 25000,
          reference: null,
        },
      ]);

      await h.service.chargeDraft(
        sale.id,
        ACTOR,
        {
          payments: [
            { method: 'cash', amountCents: 10000, paymentMethodId: PM_ID },
            { method: 'card_debit', amountCents: 25000 },
          ],
          cashSessionId: SESSION_A,
        },
        'key-order',
      );

      const call = h.ledger.recordPayments.mock.calls[0][0] as {
        payments: Array<{
          paymentId: string;
          method: string;
          metadataJson?: unknown;
        }>;
      };
      expect(call.payments.map((payment) => payment.paymentId)).toEqual([
        'pmt-cash',
        'pmt-card',
      ]);
      expect(call.payments.map((payment) => payment.method)).toEqual([
        'cash',
        'card_debit',
      ]);
      expect(call.payments[0].metadataJson).toEqual({
        catalog: {
          paymentMethodId: PM_ID,
          name: 'Efectivo',
          subtitle: 'Caja',
        },
      });
      expect(call.payments[1].metadataJson).toBeUndefined();
    });

    it('records no credit movement for a credit-only bound charge (no monetary tender)', async () => {
      const h = buildHarness();
      const sale = buildDraftSale('sale-credit-only', 5000);
      h.lockSale(sale);
      h.products.getProductInfoForSale.mockResolvedValue({
        unitPriceCents: 5000,
      });
      h.saleRepo.persistChargeConfirmation.mockResolvedValue([]);

      const result = await h.service.chargeDraft(
        sale.id,
        ACTOR,
        { method: 'credit', amountCents: 0, cashSessionId: SESSION_A },
        'key-credit-only',
      );

      expect(result.paymentStatus).toBe('CREDIT');
      expect(h.ledger.recordPayments).toHaveBeenCalledWith(
        expect.objectContaining({ payments: [], changeDueCents: 0 }),
      );
      expect(h.products.decrementStockForCharge).toHaveBeenCalled();
    });

    it('propagates a ledger write failure to the caller', async () => {
      const h = buildHarness();
      const sale = buildDraftSale('sale-ledger-down', 1000);
      setupChargeSale(h, sale);
      h.ledger.recordPayments.mockRejectedValueOnce(new Error('LEDGER_DOWN'));

      await expect(
        h.service.chargeDraft(
          sale.id,
          ACTOR,
          { method: 'cash', amountCents: 1000, cashSessionId: SESSION_A },
          'key-ledger-down',
        ),
      ).rejects.toThrow('LEDGER_DOWN');
    });

    it('fails closed when a session is requested but no ledger is wired', async () => {
      const h = buildHarness({ withoutLedger: true });
      const sale = buildDraftSale('sale-no-ledger', 1000);
      setupChargeSale(h, sale);

      await expect(
        h.service.chargeDraft(
          sale.id,
          ACTOR,
          { method: 'cash', amountCents: 1000, cashSessionId: SESSION_A },
          'key-no-ledger',
        ),
      ).rejects.toThrow('CASH_LEDGER_UNAVAILABLE');
      expect(h.saleRepo.findByIdForUpdate).not.toHaveBeenCalled();
    });

    it('includes the session in the charge hash only when present', async () => {
      const h = buildHarness();
      h.saleRepo.acquireChargeIdempotency.mockResolvedValue({
        kind: 'conflict',
      });
      const saleId = 'sale-hash';

      const call = (cashSessionId?: string) =>
        h.service
          .chargeDraft(
            saleId,
            ACTOR,
            cashSessionId === undefined
              ? { method: 'cash', amountCents: 1000 }
              : { method: 'cash', amountCents: 1000, cashSessionId },
            `key-${cashSessionId ?? 'none'}`,
          )
          .catch(() => undefined);

      await call();
      await call(SESSION_A);
      await call(SESSION_B);

      const acquireCalls = h.saleRepo.acquireChargeIdempotency.mock
        .calls as unknown as Array<[string, string, string]>;
      const [legacy, sessionA, sessionB] = acquireCalls.map((call) => call[2]);

      expect(legacy).toBe(
        sha256({
          saleId,
          actorId: ACTOR,
          payments: [{ method: 'cash', amountCents: 1000 }],
          dueDate: null,
          delivery: false,
        }),
      );
      expect(sessionA).toBe(
        sha256({
          saleId,
          actorId: ACTOR,
          payments: [{ method: 'cash', amountCents: 1000 }],
          dueDate: null,
          delivery: false,
          cashSessionId: SESSION_A,
        }),
      );
      expect(sessionB).not.toBe(sessionA);
      expect(legacy).not.toBe(sessionA);
    });
  });

  describe('addPayment', () => {
    it('keeps the unbound reviewer (bot) path unchanged and outside the ledger', async () => {
      const h = buildHarness();
      h.lockSale(buildConfirmedSale('sale-bot', 5000));
      h.saleRepo.persistCollectedPayments.mockResolvedValue({
        paymentIds: ['payment-1'],
        paidCents: 4000,
        debtCents: 1000,
        paymentStatus: 'PARTIAL',
        totalCents: 5000,
      });

      await h.service.addPayment(
        'sale-bot',
        ACTOR,
        { method: 'cash', amountCents: 2000 },
        'key-bot',
        'reviewer',
      );

      expect(h.events[0]).toBe('acquire:payment@out');
      expect(h.saleRepo.persistCollectedPayments).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: null,
          payments: [
            expect.objectContaining({
              metadataJson: { origin: { kind: 'bot', channel: 'POS' } },
            }),
          ],
        }),
      );
      expect(h.ledger.assertOpenSession).not.toHaveBeenCalled();
      expect(h.ledger.recordPayments).not.toHaveBeenCalled();
    });

    it('rejects a reviewer request that also supplies a session, before any write', async () => {
      const h = buildHarness();

      await expect(
        h.service.addPayment(
          SALE_ID,
          ACTOR,
          { method: 'cash', amountCents: 2000, cashSessionId: SESSION_A },
          'key-reviewer-session',
          'reviewer',
        ),
      ).rejects.toThrow('CASH_SESSION_REVIEWER_NOT_ALLOWED');

      expect(h.saleRepo.acquirePaymentIdempotency).not.toHaveBeenCalled();
      expect(h.saleRepo.persistCollectedPayments).not.toHaveBeenCalled();
      expect(h.ledger.assertOpenSession).not.toHaveBeenCalled();
      expect(h.ledger.recordPayments).not.toHaveBeenCalled();
    });

    it('fences before the sale lock and records the collected payment with change 0', async () => {
      const h = buildHarness();
      h.lockSale(buildConfirmedSale('sale-collect', 5000));
      h.saleRepo.persistCollectedPayments.mockResolvedValue({
        paymentIds: ['payment-1'],
        paidCents: 4000,
        debtCents: 1000,
        paymentStatus: 'PARTIAL',
        totalCents: 5000,
      });

      const result = (await h.service.addPayment(
        'sale-collect',
        ACTOR,
        { method: 'cash', amountCents: 2000, cashSessionId: SESSION_A },
        'key-collect',
      )) as { debtCents: number };

      expect(h.events.indexOf('assert:open@tx')).toBeLessThan(
        h.events.indexOf('lock:sale@tx'),
      );
      expect(result.debtCents).toBe(1000);
      expect(h.ledger.recordPayments).toHaveBeenCalledTimes(1);
      expect(h.ledger.recordPayments).toHaveBeenCalledWith({
        sessionId: SESSION_A,
        actorId: ACTOR,
        saleId: 'sale-collect',
        payments: [
          {
            paymentId: 'payment-1',
            method: 'cash',
            amountCents: 2000,
            metadataJson: undefined,
          },
        ],
        changeDueCents: 0,
        occurredAt: expect.any(Date) as unknown,
      });
    });

    it('includes the session in the collection hash only when present', async () => {
      const h = buildHarness();
      h.saleRepo.acquirePaymentIdempotency.mockResolvedValue({
        kind: 'conflict',
      });
      const saleId = 'sale-hash';

      const call = (cashSessionId?: string) =>
        h.service
          .addPayment(
            saleId,
            ACTOR,
            cashSessionId === undefined
              ? { method: 'cash', amountCents: 2000 }
              : { method: 'cash', amountCents: 2000, cashSessionId },
            `key-${cashSessionId ?? 'none'}`,
          )
          .catch(() => undefined);

      await call();
      await call(SESSION_A);
      await call(SESSION_B);

      const acquireCalls = h.saleRepo.acquirePaymentIdempotency.mock
        .calls as unknown as Array<[string, string, string]>;
      const [legacy, sessionA, sessionB] = acquireCalls.map((call) => call[2]);

      expect(legacy).toBe(
        sha256({
          saleId,
          actorId: ACTOR,
          payments: [{ method: 'cash', amountCents: 2000 }],
        }),
      );
      expect(sessionA).toBe(
        sha256({
          saleId,
          actorId: ACTOR,
          payments: [{ method: 'cash', amountCents: 2000 }],
          cashSessionId: SESSION_A,
        }),
      );
      expect(sessionB).not.toBe(sessionA);
      expect(legacy).not.toBe(sessionA);
    });
  });

  describe('settleRefund', () => {
    it('records the actual settlement with its persisted id and client effective date', async () => {
      const h = buildHarness();

      const result = await h.service.settleRefund(
        REFUND_ID,
        ACTOR,
        refundDto({ cashSessionId: SESSION_A }),
        'key-refund',
      );

      expect(result.settlementId).toBe(SETTLEMENT_ID);
      expect(h.events.indexOf('assert:open@tx')).toBeLessThan(
        h.events.indexOf('settle:refund@tx'),
      );
      expect(h.ledger.recordRefund).toHaveBeenCalledTimes(1);
      expect(h.ledger.recordRefund).toHaveBeenCalledWith({
        sessionId: SESSION_A,
        actorId: ACTOR,
        settlementId: SETTLEMENT_ID,
        amountCents: 2500,
        method: 'cash',
        occurredAt: new Date(SETTLED_AT),
      });
    });

    it('replays a completed settlement without re-asserting the OPEN fence', async () => {
      const h = buildHarness();
      const payload = {
        settlementId: SETTLEMENT_ID,
        refundId: REFUND_ID,
        saleId: SALE_ID,
        amountCents: 2500,
        method: 'cash' as const,
        reference: 'R-1',
        settledAt: new Date(SETTLED_AT).toISOString(),
        settledCents: 2500,
        outstandingCents: 0,
      };
      h.saleRepo.acquireSettlementIdempotency.mockResolvedValue({
        kind: 'replay',
        payload,
      });

      const result = await h.service.settleRefund(
        REFUND_ID,
        ACTOR,
        refundDto({ cashSessionId: SESSION_A }),
        'key-replay',
      );

      expect(result).toEqual(payload);
      expect(h.ledger.assertOpenSession).not.toHaveBeenCalled();
      expect(h.saleRepo.settleRefund).not.toHaveBeenCalled();
    });

    it('rejects a session-bound credit refund but keeps legacy credit refunds working', async () => {
      const bound = buildHarness();

      await expect(
        bound.service.settleRefund(
          REFUND_ID,
          ACTOR,
          refundDto({ method: 'credit', cashSessionId: SESSION_A }),
          'key-credit-bound',
        ),
      ).rejects.toThrow('CASH_SESSION_CREDIT_NOT_ALLOWED');

      expect(
        bound.saleRepo.acquireSettlementIdempotency,
      ).not.toHaveBeenCalled();
      expect(bound.saleRepo.settleRefund).not.toHaveBeenCalled();
      expect(bound.ledger.recordRefund).not.toHaveBeenCalled();

      const legacy = buildHarness();
      await legacy.service.settleRefund(
        REFUND_ID,
        ACTOR,
        refundDto({ method: 'credit' }),
        'key-credit-legacy',
      );

      expect(legacy.saleRepo.settleRefund).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'credit' }),
      );
      expect(legacy.ledger.assertOpenSession).not.toHaveBeenCalled();
      expect(legacy.ledger.recordRefund).not.toHaveBeenCalled();
    });

    it('fences the session before the refund/sale lock and writes nothing when it rejects', async () => {
      const h = buildHarness();
      h.ledger.assertOpenSession.mockRejectedValueOnce(
        new BusinessRuleViolationError(
          'CASH_SESSION_NOT_OPEN',
          'CASH_SESSION_NOT_OPEN',
        ),
      );

      await expect(
        h.service.settleRefund(
          REFUND_ID,
          ACTOR,
          refundDto({ cashSessionId: SESSION_A }),
          'key-fence-refund',
        ),
      ).rejects.toThrow('CASH_SESSION_NOT_OPEN');

      expect(h.saleRepo.settleRefund).not.toHaveBeenCalled();
      expect(
        h.saleRepo.markSettlementIdempotencySucceeded,
      ).not.toHaveBeenCalled();
      expect(h.ledger.recordRefund).not.toHaveBeenCalled();
      expect(h.events).toContain('acquire:settle@tx');
    });

    it('includes the session in the settlement hash only when present', async () => {
      const h = buildHarness();
      h.saleRepo.acquireSettlementIdempotency.mockResolvedValue({
        kind: 'conflict',
      });

      const call = (cashSessionId?: string) =>
        h.service
          .settleRefund(
            REFUND_ID,
            ACTOR,
            refundDto(cashSessionId === undefined ? {} : { cashSessionId }),
            `key-${cashSessionId ?? 'none'}`,
          )
          .catch(() => undefined);

      await call();
      await call(SESSION_A);
      await call(SESSION_B);

      const acquireCalls = h.saleRepo.acquireSettlementIdempotency.mock
        .calls as unknown as Array<[string, string, string]>;
      const [legacy, sessionA, sessionB] = acquireCalls.map((call) => call[2]);
      const base = {
        refundId: REFUND_ID,
        actorId: ACTOR,
        amountCents: 2500,
        method: 'cash',
        reference: 'R-1',
        settledAt: new Date(SETTLED_AT).toISOString(),
      };

      expect(legacy).toBe(sha256(base));
      expect(sessionA).toBe(sha256({ ...base, cashSessionId: SESSION_A }));
      expect(sessionB).not.toBe(sessionA);
      expect(legacy).not.toBe(sessionA);
    });

    it('keeps the unbound settlement path outside the ledger', async () => {
      const h = buildHarness();

      await h.service.settleRefund(
        REFUND_ID,
        ACTOR,
        refundDto(),
        'key-legacy-refund',
      );

      expect(h.events[0]).toBe('acquire:settle@out');
      expect(h.ledger.assertOpenSession).not.toHaveBeenCalled();
      expect(h.ledger.recordRefund).not.toHaveBeenCalled();
    });
  });
});
