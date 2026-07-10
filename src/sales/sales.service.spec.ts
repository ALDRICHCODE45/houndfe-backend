/**
 * SalesService — Application Layer Tests
 *
 * Tests for POS sales use cases: openDraft, addItem, updateItemQuantity,
 * clearItems, deleteDraft, getUserDrafts.
 */
import { SalesService } from './sales.service';
import type { ISaleRepository } from './domain/sale.repository';
import { Sale } from './domain/sale.entity';
import {
  EntityNotFoundError,
  BusinessRuleViolationError,
} from '../shared/domain/domain-error';
import type { ProductsService } from '../products/products.service';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { OutboxWriterService } from '../shared/outbox/outbox-writer.service';
import type { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import type { ISaleCommentRepository } from './comments/domain/sale-comment.repository';
import {
  SaleCustomerAssignedEvent,
  SaleCustomerClearedEvent,
  SaleShippingAddressClearedEvent,
  SaleShippingAddressSetEvent,
} from './domain/events/sale.events';
import { InvalidDueDateError } from './domain/sale.errors';

// ── Minimal mocks ──────────────────────────────────────────────────────

function makeMockSaleRepo(overrides: Partial<ISaleRepository> = {}) {
  return {
    save: jest.fn(),
    findById: jest.fn(),
    findDraftsByUserId: jest.fn(),
    delete: jest.fn(),
    findByIdForUpdate: jest.fn(),
    acquireChargeIdempotency: jest.fn(),
    markChargeIdempotencySucceeded: jest.fn(),
    acquirePaymentIdempotency: jest.fn(),
    markPaymentIdempotencySucceeded: jest.fn(),
    acquireCancellationIdempotency: jest.fn(),
    markCancellationIdempotencySucceeded: jest.fn(),
    runInTransaction: jest.fn(async (cb: any) => cb()),
    allocateNextFolio: jest.fn(),
    persistChargeConfirmation: jest.fn(),
    persistCancellation: jest.fn(),
    persistCollectedPayment: jest.fn(),
    persistCollectedPayments: jest.fn(),
    findManyConfirmed: jest.fn(),
    countConfirmed: jest.fn(),
    groupByPaymentStatusConfirmed: jest.fn(),
    countNotDeliveredConfirmed: jest.fn(),
    findDraftResponseById: jest.fn(),
    findOneWithRelations: jest.fn(),
    ...overrides,
  } as jest.Mocked<ISaleRepository>;
}

function makeMockProductsService() {
  return {
    getProductInfoForSale: jest.fn(),
    checkStockAvailability: jest.fn(),
    getApplicablePrices: jest.fn(),
    resolveListPrice: jest.fn(),
    resolvePriceListGlobalIds: jest.fn().mockResolvedValue(new Map<string, string>()),
    decrementStockForCharge: jest.fn(),
    incrementStockForRestock: jest.fn(),
  } as any;
}

/**
 * Work Unit 4 — POS promotion engine (injected as Symbol token) is the
 * `SalesService.recomputePromotions(sale)` driving port. Default mock
 * returns empty `lines` / null `order` so the existing tests stay green
 * when recompute is wired (a no-op when no promotions match).
 */
function makeMockPosEvaluateUseCase() {
  return {
    evaluate: jest.fn().mockResolvedValue({
      lines: [],
      order: null,
      availableManualPromotions: [],
    }),
  } as any;
}

function makeMockEventEmitter() {
  return {
    emit: jest.fn(),
  } as unknown as EventEmitter2;
}

function makeMockOutboxWriter() {
  return {
    publish: jest.fn(),
  } as jest.Mocked<Pick<OutboxWriterService, 'publish'>>;
}

function makeMockSaleCommentRepo() {
  return {
    findActiveBySale: jest.fn(),
  } as jest.Mocked<Pick<ISaleCommentRepository, 'findActiveBySale'>>;
}

function createService(
  saleRepo: ISaleRepository,
  productsService: ProductsService,
  eventEmitter: EventEmitter2,
  outboxWriter: Pick<OutboxWriterService, 'publish'>,
  tenantPrisma: Pick<TenantPrismaService, 'getTenantId' | 'getClient'>,
  saleCommentRepo: Pick<ISaleCommentRepository, 'findActiveBySale'>,
  posEvaluateUseCase: { evaluate: jest.Mock } = makeMockPosEvaluateUseCase(),
) {
  return new SalesService(
    saleRepo,
    productsService,
    eventEmitter,
    outboxWriter,
    tenantPrisma as TenantPrismaService,
    saleCommentRepo,
    posEvaluateUseCase as any,
  );
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('SalesService', () => {
  let saleRepo: ReturnType<typeof makeMockSaleRepo>;
  let productsService: ReturnType<typeof makeMockProductsService>;
  let eventEmitter: ReturnType<typeof makeMockEventEmitter>;
  let outboxWriter: ReturnType<typeof makeMockOutboxWriter>;
  let saleCommentRepo: ReturnType<typeof makeMockSaleCommentRepo>;
  let posEvaluateUseCase: ReturnType<typeof makeMockPosEvaluateUseCase>;
  let tenantPrisma: Pick<TenantPrismaService, 'getTenantId' | 'getClient'>;
  let service: SalesService;

  beforeEach(() => {
    saleRepo = makeMockSaleRepo();
    productsService = makeMockProductsService();
    eventEmitter = makeMockEventEmitter();
    outboxWriter = makeMockOutboxWriter();
    saleCommentRepo = makeMockSaleCommentRepo();
    posEvaluateUseCase = makeMockPosEvaluateUseCase();
    tenantPrisma = {
      getTenantId: jest.fn(() => 'tenant-1'),
      getClient: jest.fn(() => ({}) as never),
    };
    service = createService(
      saleRepo,
      productsService,
      eventEmitter,
      outboxWriter,
      tenantPrisma,
      saleCommentRepo,
      posEvaluateUseCase,
    );
    saleRepo.acquireChargeIdempotency.mockResolvedValue({
      kind: 'acquired',
      token: 'idem-token',
    });
    saleRepo.markChargeIdempotencySucceeded.mockResolvedValue(undefined);
    saleRepo.acquirePaymentIdempotency.mockResolvedValue({
      kind: 'acquired',
      token: 'payment-idem-token',
    });
    saleRepo.markPaymentIdempotencySucceeded.mockResolvedValue(undefined);
    saleRepo.acquireCancellationIdempotency.mockResolvedValue({
      kind: 'acquired',
      token: 'cancel-idem-token',
    });
    saleRepo.markCancellationIdempotencySucceeded.mockResolvedValue(undefined);
    saleCommentRepo.findActiveBySale.mockResolvedValue([]);
    saleRepo.persistCancellation.mockResolvedValue(undefined);
    saleRepo.persistCollectedPayment.mockResolvedValue({
      paymentId: 'payment-1',
      paidCents: 4000,
      debtCents: 1000,
      paymentStatus: 'PARTIAL',
      totalCents: 5000,
    });
    saleRepo.persistCollectedPayments.mockResolvedValue({
      paymentIds: ['payment-1'],
      paidCents: 4000,
      debtCents: 1000,
      paymentStatus: 'PARTIAL',
      totalCents: 5000,
    });
    productsService.incrementStockForRestock.mockResolvedValue(undefined);
    outboxWriter.publish.mockResolvedValue(undefined);
  });

  describe('addPayment', () => {
    const buildConfirmedSale = (
      id: string,
      userId = 'user-1',
      totalCents = 5000,
    ) =>
      Sale.fromPersistence({
        id,
        userId,
        status: 'CONFIRMED',
        customerId: 'customer-1',
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

    it('collects payment on sale with debt and updates financial fields', async () => {
      const sale = buildConfirmedSale('sale-payment-happy', 'user-1', 5000);
      saleRepo.findByIdForUpdate.mockResolvedValue(sale);

      const result = (await service.addPayment(
        sale.id,
        'user-1',
        { method: 'cash', amountCents: 2000, reference: 'RCPT-1' },
        'idem-pay-happy',
      )) as {
        paymentStatus: string;
        paidCents: number;
        debtCents: number;
        paymentIds: string[];
      };

      expect(result.paymentStatus).toBe('PARTIAL');
      expect(result.paidCents).toBe(4000);
      expect(result.debtCents).toBe(1000);
      expect(result.paymentIds).toEqual(['payment-1']);
      expect(saleRepo.persistCollectedPayments).toHaveBeenCalledWith(
        expect.objectContaining({
          saleId: sale.id,
          userId: 'user-1',
          payments: [
            expect.objectContaining({
              method: 'cash',
              amountCents: 2000,
              reference: 'RCPT-1',
            }),
          ],
        }),
      );
    });

    it('emits only sale.payment.received outbox event for partial addPayment', async () => {
      const sale = buildConfirmedSale(
        'sale-payment-outbox-partial',
        'user-1',
        5000,
      );
      saleRepo.findByIdForUpdate.mockResolvedValue(sale);

      await service.addPayment(
        sale.id,
        'user-1',
        { method: 'cash', amountCents: 2000, reference: 'RCPT-1' },
        'idem-pay-outbox-partial',
      );

      expect(outboxWriter.publish).toHaveBeenCalledTimes(1);
      expect(outboxWriter.publish).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        'Sale',
        sale.id,
        'sale.payment.received',
        expect.objectContaining({
          saleId: sale.id,
          tenantId: 'tenant-1',
          actorId: 'user-1',
          paymentId: 'payment-1',
          method: 'cash',
          amountCents: 2000,
          reference: 'RCPT-1',
          resultingPaidCents: 4000,
          resultingDebtCents: 1000,
          resultingPaymentStatus: 'PARTIAL',
          occurredAt: expect.any(String),
        }),
      );
    });

    it('emits sale.payment.received and sale.fully.paid outbox events when addPayment settles debt', async () => {
      const sale = buildConfirmedSale(
        'sale-payment-outbox-full',
        'user-1',
        5000,
      );
      saleRepo.findByIdForUpdate.mockResolvedValue(sale);
      saleRepo.persistCollectedPayments.mockResolvedValue({
        paymentIds: ['payment-final'],
        paidCents: 5000,
        debtCents: 0,
        paymentStatus: 'PAID',
        totalCents: 5000,
      });

      await service.addPayment(
        sale.id,
        'user-1',
        { method: 'transfer', amountCents: 1000, reference: 'TRX-1' },
        'idem-pay-outbox-full',
      );

      expect(outboxWriter.publish).toHaveBeenCalledTimes(2);
      expect(outboxWriter.publish).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        expect.any(String),
        'Sale',
        sale.id,
        'sale.fully.paid',
        expect.objectContaining({ saleId: sale.id, totalCents: 5000 }),
      );
    });

    it('rejects overpayment with PAYMENT_EXCEEDS_DEBT', async () => {
      const sale = buildConfirmedSale('sale-payment-overpay', 'user-1', 5000);
      saleRepo.findByIdForUpdate.mockResolvedValue(sale);
      saleRepo.persistCollectedPayments.mockRejectedValue(
        new BusinessRuleViolationError(
          'PAYMENT_EXCEEDS_DEBT',
          'PAYMENT_EXCEEDS_DEBT',
        ),
      );

      await expect(
        service.addPayment(
          sale.id,
          'user-1',
          { method: 'cash', amountCents: 1500 },
          'idem-pay-overpay',
        ),
      ).rejects.toThrow('PAYMENT_EXCEEDS_DEBT');
    });

    it('rejects payment when sale has no debt', async () => {
      const sale = buildConfirmedSale('sale-payment-no-debt', 'user-1', 5000);
      saleRepo.findByIdForUpdate.mockResolvedValue(sale);
      saleRepo.persistCollectedPayments.mockRejectedValue(
        new BusinessRuleViolationError(
          'NO_OUTSTANDING_DEBT',
          'NO_OUTSTANDING_DEBT',
        ),
      );

      await expect(
        service.addPayment(
          sale.id,
          'user-1',
          { method: 'card_debit', amountCents: 100 },
          'idem-pay-no-debt',
        ),
      ).rejects.toThrow('NO_OUTSTANDING_DEBT');
    });

    it('rejects credit method with PAYMENT_METHOD_NOT_SUPPORTED', async () => {
      const sale = buildConfirmedSale(
        'sale-payment-credit-method',
        'user-1',
        5000,
      );
      saleRepo.findByIdForUpdate.mockResolvedValue(sale);

      await expect(
        service.addPayment(
          sale.id,
          'user-1',
          { method: 'credit', amountCents: 1000 },
          'idem-pay-credit-method',
        ),
      ).rejects.toThrow('PAYMENT_METHOD_NOT_SUPPORTED');
    });

    it('returns not found when actor tenant/user cannot access sale', async () => {
      const sale = buildConfirmedSale(
        'sale-payment-tenant-404',
        'user-1',
        5000,
      );
      saleRepo.findByIdForUpdate.mockResolvedValue(sale);

      await expect(
        service.addPayment(
          sale.id,
          'user-2',
          { method: 'cash', amountCents: 500 },
          'idem-pay-tenant-404',
        ),
      ).rejects.toThrow('SALE_NOT_FOUND');
    });

    it('keeps owner authorization as the default addPayment mode', async () => {
      const sale = buildConfirmedSale(
        'sale-payment-default-owner-mode',
        'owner-1',
        5000,
      );
      saleRepo.findByIdForUpdate.mockResolvedValue(sale);

      await service.addPayment(
        sale.id,
        'owner-1',
        { method: 'cash', amountCents: 500 },
        'idem-pay-default-owner-mode',
      );

      expect(saleRepo.persistCollectedPayments).toHaveBeenCalledWith(
        expect.objectContaining({
          saleId: sale.id,
          userId: 'owner-1',
          payments: [
            expect.objectContaining({
              method: 'cash',
              amountCents: 500,
            }),
          ],
        }),
      );
    });

    it('allows reviewer mode to collect payment for a non-owner sale as bot-originated transfer', async () => {
      const sale = buildConfirmedSale(
        'sale-payment-reviewer-mode',
        'cashier-1',
        5000,
      );
      saleRepo.findByIdForUpdate.mockResolvedValue(sale);

      await service.addPayment(
        sale.id,
        'reviewer-1',
        { method: 'cash', amountCents: 500, reference: 'BANK-1' },
        'idem-pay-reviewer-mode',
        'reviewer',
      );

      expect(saleRepo.persistCollectedPayments).toHaveBeenCalledWith(
        expect.objectContaining({
          saleId: sale.id,
          userId: null,
          payments: [
            expect.objectContaining({
              method: 'transfer',
              amountCents: 500,
              reference: 'BANK-1',
              metadataJson: {
                origin: { kind: 'bot', channel: 'POS' },
              },
            }),
          ],
        }),
      );
    });

    it('emits sale.payment.received with null actorId on the reviewer path (D7: reviewer is not the payer)', async () => {
      const sale = buildConfirmedSale(
        'sale-payment-reviewer-event',
        'cashier-1',
        5000,
      );
      saleRepo.findByIdForUpdate.mockResolvedValue(sale);

      await service.addPayment(
        sale.id,
        'reviewer-1',
        { method: 'cash', amountCents: 500, reference: 'BANK-1' },
        'idem-pay-reviewer-event',
        'reviewer',
      );

      expect(outboxWriter.publish).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        'Sale',
        sale.id,
        'sale.payment.received',
        expect.objectContaining({
          actorId: null,
          method: 'transfer',
          amountCents: 500,
        }),
      );
    });

    it('emits sale.payment.received with the cashier actorId on the owner path (regression guard)', async () => {
      const sale = buildConfirmedSale(
        'sale-payment-owner-event-guard',
        'cashier-1',
        5000,
      );
      saleRepo.findByIdForUpdate.mockResolvedValue(sale);

      await service.addPayment(
        sale.id,
        'cashier-1',
        { method: 'cash', amountCents: 500 },
        'idem-pay-owner-event-guard',
      );

      expect(outboxWriter.publish).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        'Sale',
        sale.id,
        'sale.payment.received',
        expect.objectContaining({
          actorId: 'cashier-1',
          method: 'cash',
          amountCents: 500,
        }),
      );
    });

    it('replays original response when idempotency key repeats', async () => {
      const replayPayload = {
        saleId: 'sale-payment-replay',
        paidCents: 3000,
        debtCents: 2000,
        paymentStatus: 'PARTIAL' as const,
      };

      (saleRepo.acquirePaymentIdempotency as jest.Mock).mockResolvedValue({
        kind: 'replay',
        payload: replayPayload,
      });

      const result = await service.addPayment(
        'sale-payment-replay',
        'user-1',
        { method: 'cash', amountCents: 1000 },
        'idem-pay-replay',
      );

      expect(result).toEqual(replayPayload);
      expect(saleRepo.findByIdForUpdate).not.toHaveBeenCalled();
    });

    it('rejects mixed shape for addPayment with AMBIGUOUS_PAYMENT_SHAPE', async () => {
      await expect(
        service.addPayment(
          'sale-payment-mixed-shape',
          'user-1',
          {
            method: 'cash',
            amountCents: 1000,
            payments: [{ method: 'cash', amountCents: 1000 }],
          } as never,
          'idem-pay-mixed-shape',
        ),
      ).rejects.toThrow('AMBIGUOUS_PAYMENT_SHAPE');
    });

    it('rejects empty payments array for addPayment with EMPTY_PAYMENTS', async () => {
      await expect(
        service.addPayment(
          'sale-payment-empty-array',
          'user-1',
          { payments: [] } as never,
          'idem-pay-empty-array',
        ),
      ).rejects.toThrow('EMPTY_PAYMENTS');
    });

    it('uses stable addPayment idempotency hash for reordered payments[]', async () => {
      const replayPayload = {
        saleId: 'sale-payment-reorder-replay',
        paidCents: 3000,
        debtCents: 2000,
        totalCents: 5000,
        paymentStatus: 'PARTIAL' as const,
        paymentIds: ['payment-1', 'payment-2'],
      };

      const hashes = new Map<string, unknown>();
      saleRepo.acquirePaymentIdempotency.mockImplementation(
        async (_saleId: string, _key: string, requestHash: string) => {
          if (hashes.has(requestHash)) {
            return { kind: 'replay', payload: replayPayload };
          }

          hashes.set(requestHash, true);
          return { kind: 'acquired', token: 'payment-idem-token' };
        },
      );

      saleRepo.findByIdForUpdate.mockResolvedValue(
        buildConfirmedSale('sale-payment-reorder-replay', 'user-1', 5000),
      );

      await service.addPayment(
        'sale-payment-reorder-replay',
        'user-1',
        {
          payments: [
            { method: 'transfer', amountCents: 1000, reference: 'TRX-2' },
            { method: 'cash', amountCents: 2000 },
          ],
        } as never,
        'idem-pay-reorder',
      );

      const replay = await service.addPayment(
        'sale-payment-reorder-replay',
        'user-1',
        {
          payments: [
            { method: 'cash', amountCents: 2000 },
            { method: 'transfer', amountCents: 1000, reference: 'TRX-2' },
          ],
        } as never,
        'idem-pay-reorder',
      );

      expect(replay).toEqual(replayPayload);
    });

    it('publishes one payment.received event per entry and one fully.paid when debt reaches zero', async () => {
      saleRepo.findByIdForUpdate.mockResolvedValue(
        buildConfirmedSale('sale-payment-multi-events', 'user-1', 5000),
      );
      saleRepo.persistCollectedPayments.mockResolvedValue({
        paymentIds: ['p-1', 'p-2'],
        paidCents: 5000,
        debtCents: 0,
        paymentStatus: 'PAID',
        totalCents: 5000,
      });

      await service.addPayment(
        'sale-payment-multi-events',
        'user-1',
        {
          payments: [
            { method: 'cash', amountCents: 1000 },
            { method: 'transfer', amountCents: 2000, reference: 'TRX-1' },
          ],
        } as never,
        'idem-pay-multi-events',
      );

      const paymentEvents = outboxWriter.publish.mock.calls.filter(
        (args) => args[4] === 'sale.payment.received',
      );
      const fullyPaidEvents = outboxWriter.publish.mock.calls.filter(
        (args) => args[4] === 'sale.fully.paid',
      );

      expect(paymentEvents).toHaveLength(2);
      expect(fullyPaidEvents).toHaveLength(1);
    });
  });

  describe('setDueDate', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-06-10T16:30:00.000Z'));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('updates dueDate on confirmed non-paid sale', async () => {
      const sale = Sale.fromPersistence({
        id: 'sale-due-date-1',
        userId: 'user-1',
        status: 'CONFIRMED',
        confirmedAt: new Date('2026-05-15T18:00:00.000Z'),
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      saleRepo.findById.mockResolvedValue(sale);
      saleRepo.findOneWithRelations.mockResolvedValue({
        paymentStatus: 'PARTIAL',
      });
      jest
        .spyOn(service, 'getSaleDetail')
        .mockResolvedValue({ id: sale.id } as never);

      await service.setDueDate(sale.id, {
        dueDate: '2026-07-01T00:00:00.000Z',
      });

      expect(saleRepo.save).toHaveBeenCalled();
    });

    it('throws InvalidDueDateError when dueDate is before start of today (UTC)', async () => {
      const sale = Sale.fromPersistence({
        id: 'sale-due-date-yesterday',
        userId: 'user-1',
        status: 'CONFIRMED',
        confirmedAt: new Date('2026-05-15T18:00:00.000Z'),
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      saleRepo.findById.mockResolvedValue(sale);
      saleRepo.findOneWithRelations.mockResolvedValue({
        paymentStatus: 'PARTIAL',
      });
      jest
        .spyOn(service, 'getSaleDetail')
        .mockResolvedValue({ id: sale.id } as never);

      await expect(
        service.setDueDate(sale.id, { dueDate: '2026-06-09T23:59:59.999Z' }),
      ).rejects.toBeInstanceOf(InvalidDueDateError);
    });

    it('allows dueDate on current UTC day regardless of time', async () => {
      const sale = Sale.fromPersistence({
        id: 'sale-due-date-today',
        userId: 'user-1',
        status: 'CONFIRMED',
        confirmedAt: new Date('2026-05-15T18:00:00.000Z'),
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      saleRepo.findById.mockResolvedValue(sale);
      saleRepo.findOneWithRelations.mockResolvedValue({
        paymentStatus: 'PARTIAL',
      });
      jest
        .spyOn(service, 'getSaleDetail')
        .mockResolvedValue({ id: sale.id } as never);

      await expect(
        service.setDueDate(sale.id, { dueDate: '2026-06-10T03:25:00.000Z' }),
      ).resolves.toEqual({ id: sale.id });
    });

    it('allows dueDate on tomorrow (UTC)', async () => {
      const sale = Sale.fromPersistence({
        id: 'sale-due-date-tomorrow',
        userId: 'user-1',
        status: 'CONFIRMED',
        confirmedAt: new Date('2026-05-15T18:00:00.000Z'),
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      saleRepo.findById.mockResolvedValue(sale);
      saleRepo.findOneWithRelations.mockResolvedValue({
        paymentStatus: 'PARTIAL',
      });
      jest
        .spyOn(service, 'getSaleDetail')
        .mockResolvedValue({ id: sale.id } as never);

      await expect(
        service.setDueDate(sale.id, { dueDate: '2026-06-11T00:00:00.000Z' }),
      ).resolves.toEqual({ id: sale.id });
    });

    it('allows null dueDate to clear value', async () => {
      const sale = Sale.fromPersistence({
        id: 'sale-due-date-clear',
        userId: 'user-1',
        status: 'CONFIRMED',
        confirmedAt: new Date('2026-05-15T18:00:00.000Z'),
        dueDate: new Date('2026-06-20T00:00:00.000Z'),
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      saleRepo.findById.mockResolvedValue(sale);
      saleRepo.findOneWithRelations.mockResolvedValue({
        paymentStatus: 'PARTIAL',
      });
      jest
        .spyOn(service, 'getSaleDetail')
        .mockResolvedValue({ id: sale.id } as never);

      await expect(
        service.setDueDate(sale.id, { dueDate: null }),
      ).resolves.toEqual({
        id: sale.id,
      });
      expect(sale.dueDate).toBeNull();
    });

    it('throws SALE_NOT_FOUND when sale does not exist', async () => {
      saleRepo.findById.mockResolvedValue(null);
      await expect(
        service.setDueDate('missing-sale', { dueDate: null }),
      ).rejects.toThrow('SALE_NOT_FOUND');
    });

    it('throws SALE_FULLY_PAID when paymentStatus is PAID', async () => {
      const sale = Sale.fromPersistence({
        id: 'sale-paid',
        userId: 'user-1',
        status: 'CONFIRMED',
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      saleRepo.findById.mockResolvedValue(sale);
      saleRepo.findOneWithRelations.mockResolvedValue({
        paymentStatus: 'PAID',
      });

      await expect(
        service.setDueDate('sale-paid', {
          dueDate: '2026-08-01T00:00:00.000Z',
        }),
      ).rejects.toThrow('SALE_FULLY_PAID');
    });
  });

  describe('assignSeller', () => {
    it('assigns seller and emits sale.seller.assigned when seller changes', async () => {
      const sale = Sale.fromPersistence({
        id: 'sale-seller-1',
        userId: 'user-1',
        status: 'CONFIRMED',
        sellerUserId: null,
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      saleRepo.findById.mockResolvedValue(sale);
      (tenantPrisma.getClient as jest.Mock).mockReturnValue({
        user: { findUnique: jest.fn().mockResolvedValue({ id: 'seller-1' }) },
      });
      jest
        .spyOn(service, 'getSaleDetail')
        .mockResolvedValue({ id: sale.id } as never);

      await service.assignSeller(sale.id, 'actor-1', {
        sellerUserId: 'seller-1',
      });

      expect(saleRepo.save).toHaveBeenCalledWith(sale);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'sale.seller.assigned',
        expect.objectContaining({
          saleId: sale.id,
          sellerUserId: 'seller-1',
          previousSellerUserId: null,
          userId: 'actor-1',
        }),
      );
    });

    it('does not emit event when assigning the same seller id', async () => {
      const sale = Sale.fromPersistence({
        id: 'sale-seller-2',
        userId: 'user-1',
        status: 'DRAFT',
        sellerUserId: 'seller-1',
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      saleRepo.findById.mockResolvedValue(sale);
      (tenantPrisma.getClient as jest.Mock).mockReturnValue({
        user: { findUnique: jest.fn().mockResolvedValue({ id: 'seller-1' }) },
      });
      saleRepo.findDraftResponseById.mockResolvedValue({
        id: sale.id,
      } as never);

      await service.assignSeller(sale.id, 'actor-1', {
        sellerUserId: 'seller-1',
      });

      expect(eventEmitter.emit).not.toHaveBeenCalledWith(
        'sale.seller.assigned',
        expect.anything(),
      );
    });

    it('throws SELLER_NOT_FOUND when seller user does not exist in tenant', async () => {
      const sale = Sale.fromPersistence({
        id: 'sale-seller-3',
        userId: 'user-1',
        status: 'CONFIRMED',
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      saleRepo.findById.mockResolvedValue(sale);
      (tenantPrisma.getClient as jest.Mock).mockReturnValue({
        user: { findUnique: jest.fn().mockResolvedValue(null) },
      });

      await expect(
        service.assignSeller(sale.id, 'actor-1', {
          sellerUserId: 'seller-missing',
        }),
      ).rejects.toThrow('SELLER_NOT_FOUND');
    });
  });

  describe('clearSeller', () => {
    it('clears seller and emits sale.seller.cleared when seller existed', async () => {
      const sale = Sale.fromPersistence({
        id: 'sale-seller-4',
        userId: 'user-1',
        status: 'CONFIRMED',
        sellerUserId: 'seller-1',
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      saleRepo.findById.mockResolvedValue(sale);
      jest
        .spyOn(service, 'getSaleDetail')
        .mockResolvedValue({ id: sale.id } as never);

      await service.clearSeller(sale.id, 'actor-1');

      expect(saleRepo.save).toHaveBeenCalledWith(sale);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'sale.seller.cleared',
        expect.objectContaining({
          saleId: sale.id,
          previousSellerUserId: 'seller-1',
          userId: 'actor-1',
        }),
      );
    });

    it('does not emit event when seller is already null', async () => {
      const sale = Sale.fromPersistence({
        id: 'sale-seller-5',
        userId: 'user-1',
        status: 'DRAFT',
        sellerUserId: null,
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      saleRepo.findById.mockResolvedValue(sale);
      saleRepo.findDraftResponseById.mockResolvedValue({
        id: sale.id,
      } as never);

      await service.clearSeller(sale.id, 'actor-1');

      expect(eventEmitter.emit).not.toHaveBeenCalledWith(
        'sale.seller.cleared',
        expect.anything(),
      );
    });
  });

  describe('draft customer and shipping address mutations', () => {
    const makeDraftSale = (overrides?: {
      customerId?: string | null;
      shippingAddressId?: string | null;
    }) =>
      Sale.fromPersistence({
        id: '68f2f172-bfe8-48de-8d58-5e564f94c574',
        userId: 'bf464f5b-267b-43c5-87c8-2b655bf7ffbc',
        status: 'DRAFT',
        customerId: overrides?.customerId ?? null,
        shippingAddressId: overrides?.shippingAddressId ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
        items: [],
      });

    const draftResponse = {
      id: '68f2f172-bfe8-48de-8d58-5e564f94c574',
      userId: 'bf464f5b-267b-43c5-87c8-2b655bf7ffbc',
      status: 'DRAFT',
      customerId: 'f9d2f368-10be-4f4b-a3cc-0e67735f7f26',
      shippingAddressId: '8f311d31-131f-449a-8a15-6a3257b0d865',
      customer: {
        id: 'f9d2f368-10be-4f4b-a3cc-0e67735f7f26',
        firstName: 'Ada',
        lastName: 'Lovelace',
      },
      shippingAddress: {
        id: '8f311d31-131f-449a-8a15-6a3257b0d865',
        street: 'Main',
        exteriorNumber: '1',
        interiorNumber: null,
        zipCode: '64000',
        neighborhood: 'Centro',
        municipality: 'Monterrey',
        city: 'Monterrey',
        state: 'Nuevo León',
      },
      items: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it('assigns customer and returns joined draft response', async () => {
      const sale = makeDraftSale();
      saleRepo.findById.mockResolvedValue(sale);
      const prismaClient = {
        customer: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ id: draftResponse.customer.id }),
        },
        customerAddress: {
          findUnique: jest.fn().mockResolvedValue({
            id: draftResponse.shippingAddress.id,
            customerId: draftResponse.customer.id,
          }),
        },
      };
      tenantPrisma.getClient = jest.fn(() => prismaClient as never);
      saleRepo.findDraftResponseById.mockResolvedValue(draftResponse as never);

      const result = await service.assignCustomer(sale.id, sale.userId, {
        customerId: draftResponse.customer.id,
        shippingAddressId: draftResponse.shippingAddress.id,
      });

      expect(result).toEqual(draftResponse);
      expect(saleRepo.save).toHaveBeenCalledWith(sale);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'sale.customer.assigned',
        expect.any(SaleCustomerAssignedEvent),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'sale.shipping-address.set',
        expect.any(SaleShippingAddressSetEvent),
      );
    });

    it('rejects assignCustomer when customer does not exist in tenant', async () => {
      const sale = makeDraftSale();
      saleRepo.findById.mockResolvedValue(sale);
      const prismaClient = {
        customer: { findUnique: jest.fn().mockResolvedValue(null) },
      };
      tenantPrisma.getClient = jest.fn(() => prismaClient as never);

      await expect(
        service.assignCustomer(sale.id, sale.userId, {
          customerId: '2bd9bf5e-5d8f-40fc-b2d7-e99e8cf1ba2f',
        }),
      ).rejects.toThrow('CUSTOMER_NOT_FOUND');
    });

    it('clears customer and emits cleared events only on change', async () => {
      const sale = makeDraftSale({
        customerId: 'f9d2f368-10be-4f4b-a3cc-0e67735f7f26',
        shippingAddressId: '8f311d31-131f-449a-8a15-6a3257b0d865',
      });
      saleRepo.findById.mockResolvedValue(sale);

      await service.clearCustomer(sale.id, sale.userId);

      expect(saleRepo.save).toHaveBeenCalledWith(sale);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'sale.customer.cleared',
        expect.any(SaleCustomerClearedEvent),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'sale.shipping-address.cleared',
        expect.any(SaleShippingAddressClearedEvent),
      );
    });

    it('does not emit clear events when customer already null', async () => {
      const sale = makeDraftSale();
      saleRepo.findById.mockResolvedValue(sale);

      await service.clearCustomer(sale.id, sale.userId);

      expect(saleRepo.save).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalledWith(
        'sale.customer.cleared',
        expect.anything(),
      );
    });

    it('requires customer before setting shipping address', async () => {
      const sale = makeDraftSale({ customerId: null });
      saleRepo.findById.mockResolvedValue(sale);

      await expect(
        service.setShippingAddress(sale.id, sale.userId, {
          shippingAddressId: '8f311d31-131f-449a-8a15-6a3257b0d865',
        }),
      ).rejects.toThrow('SHIPPING_ADDRESS_REQUIRES_CUSTOMER');
    });

    it('clears shipping address via null body', async () => {
      const sale = makeDraftSale({
        customerId: 'f9d2f368-10be-4f4b-a3cc-0e67735f7f26',
        shippingAddressId: '8f311d31-131f-449a-8a15-6a3257b0d865',
      });
      saleRepo.findById.mockResolvedValue(sale);

      await service.setShippingAddress(sale.id, sale.userId, {
        shippingAddressId: null,
      });

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'sale.shipping-address.cleared',
        expect.any(SaleShippingAddressClearedEvent),
      );
    });
  });

  describe('chargeDraft', () => {
    const buildDraftSale = (
      id: string,
      userId = 'user-1',
      customerId: string | null = null,
    ) =>
      Sale.fromPersistence({
        id,
        userId,
        customerId,
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
            quantity: 2,
            unitPriceCents: 1000,
            unitPriceCurrency: 'MXN',
          },
        ],
      });

    const setupHappyPathDraft = (sale: Sale) => {
      saleRepo.findByIdForUpdate.mockResolvedValue(sale);
      productsService.getProductInfoForSale.mockResolvedValue({
        unitPriceCents: 1000,
      });
      productsService.decrementStockForCharge.mockResolvedValue([]);
      saleRepo.allocateNextFolio.mockResolvedValue('A-2605-000014');
      saleRepo.persistChargeConfirmation.mockResolvedValue([]);
    };

    it('accepts new payments[] shape and computes totals', async () => {
      const sale = buildDraftSale(
        'sale-charge-array-ok',
        'user-1',
        'customer-1',
      );
      setupHappyPathDraft(sale);

      const result = await service.chargeDraft(
        sale.id,
        'user-1',
        {
          payments: [
            { method: 'cash', amountCents: 1000 },
            { method: 'card_debit', amountCents: 1000, reference: 'REF-1' },
          ],
        } as never,
        'idem-array-ok',
      );

      expect(result.paymentStatus).toBe('PAID');
      expect(result.paidCents).toBe(2000);
      expect(result.debtCents).toBe(0);
    });

    it('emits sale.confirmed + payment.received + fully.paid outbox events for fully-paid chargeDraft', async () => {
      const sale = buildDraftSale(
        'sale-charge-outbox-full',
        'user-1',
        'customer-1',
      );
      setupHappyPathDraft(sale);
      saleRepo.persistChargeConfirmation.mockResolvedValue([
        {
          paymentId: 'pmt-1',
          method: 'cash',
          amountCents: 1000,
          reference: null,
        },
        {
          paymentId: 'pmt-2',
          method: 'card_debit',
          amountCents: 1000,
          reference: 'REF-1',
        },
      ]);

      await service.chargeDraft(
        sale.id,
        'user-1',
        {
          payments: [
            { method: 'cash', amountCents: 1000 },
            { method: 'card_debit', amountCents: 1000, reference: 'REF-1' },
          ],
        } as never,
        'idem-charge-outbox-full',
      );

      expect(outboxWriter.publish).toHaveBeenCalledTimes(4);
      expect(outboxWriter.publish).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        expect.any(String),
        'Sale',
        sale.id,
        'sale.confirmed',
        {
          saleId: sale.id,
          folio: 'A-2605-000014',
          tenantId: 'tenant-1',
          actorId: 'user-1',
          totalCents: 2000,
          paidCents: 2000,
          debtCents: 0,
          paymentStatus: 'PAID',
          confirmedAt: expect.any(String),
        },
      );
      expect(outboxWriter.publish).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        expect.any(String),
        'Sale',
        sale.id,
        'sale.payment.received',
        expect.objectContaining({
          saleId: sale.id,
          paymentId: 'pmt-1',
          tenantId: 'tenant-1',
          actorId: 'user-1',
          method: 'cash',
          amountCents: 1000,
          reference: undefined,
          resultingPaidCents: 1000,
          resultingDebtCents: 1000,
          resultingPaymentStatus: 'PARTIAL',
          occurredAt: expect.any(String),
        }),
      );
      expect(outboxWriter.publish).toHaveBeenNthCalledWith(
        4,
        expect.anything(),
        expect.any(String),
        'Sale',
        sale.id,
        'sale.fully.paid',
        expect.objectContaining({ saleId: sale.id, totalCents: 2000 }),
      );
    });

    it('does not emit sale.fully.paid on partial chargeDraft', async () => {
      const sale = buildDraftSale(
        'sale-charge-outbox-partial',
        'user-1',
        'customer-1',
      );
      setupHappyPathDraft(sale);
      saleRepo.persistChargeConfirmation.mockResolvedValue([
        {
          paymentId: 'pmt-1',
          method: 'cash',
          amountCents: 1500,
          reference: null,
        },
      ]);

      await service.chargeDraft(
        sale.id,
        'user-1',
        { method: 'cash', amountCents: 1500 },
        'idem-charge-outbox-partial',
      );

      const eventTypes = outboxWriter.publish.mock.calls.map((args) => args[4]);
      expect(eventTypes).toContain('sale.confirmed');
      expect(eventTypes).toContain('sale.payment.received');
      expect(eventTypes).not.toContain('sale.fully.paid');
    });

    it('rejects mixed shape with AMBIGUOUS_PAYMENT_SHAPE', async () => {
      const sale = buildDraftSale(
        'sale-charge-mixed-shape',
        'user-1',
        'customer-1',
      );
      setupHappyPathDraft(sale);

      await expect(
        service.chargeDraft(
          sale.id,
          'user-1',
          {
            method: 'cash',
            amountCents: 2000,
            payments: [{ method: 'cash', amountCents: 2000 }],
          } as never,
          'idem-mixed-shape',
        ),
      ).rejects.toThrow('AMBIGUOUS_PAYMENT_SHAPE');
    });

    it('rejects credit method inside payments[] with CREDIT_METHOD_NOT_VALID_IN_MULTI', async () => {
      const sale = buildDraftSale(
        'sale-charge-array-credit',
        'user-1',
        'customer-1',
      );
      setupHappyPathDraft(sale);

      await expect(
        service.chargeDraft(
          sale.id,
          'user-1',
          {
            payments: [{ method: 'credit', amountCents: 0 }],
          } as never,
          'idem-array-credit',
        ),
      ).rejects.toThrow('CREDIT_METHOD_NOT_VALID_IN_MULTI');
    });

    it('rejects missing reference for card/transfer with REFERENCE_REQUIRED', async () => {
      const sale = buildDraftSale(
        'sale-charge-array-reference',
        'user-1',
        'customer-1',
      );
      setupHappyPathDraft(sale);

      await expect(
        service.chargeDraft(
          sale.id,
          'user-1',
          {
            payments: [{ method: 'card_debit', amountCents: 2000 }],
          } as never,
          'idem-array-reference',
        ),
      ).rejects.toThrow('REFERENCE_REQUIRED');
    });

    it('rejects more than five payment entries with TOO_MANY_PAYMENTS', async () => {
      const sale = buildDraftSale(
        'sale-charge-array-too-many',
        'user-1',
        'customer-1',
      );
      setupHappyPathDraft(sale);

      await expect(
        service.chargeDraft(
          sale.id,
          'user-1',
          {
            payments: [
              { method: 'cash', amountCents: 1 },
              { method: 'cash', amountCents: 1 },
              { method: 'cash', amountCents: 1 },
              { method: 'cash', amountCents: 1 },
              { method: 'cash', amountCents: 1 },
              { method: 'cash', amountCents: 1 },
            ],
          } as never,
          'idem-array-too-many',
        ),
      ).rejects.toThrow('TOO_MANY_PAYMENTS');
    });

    it('rejects empty payments[] without customer with CUSTOMER_REQUIRED_FOR_CREDIT', async () => {
      const sale = buildDraftSale('sale-charge-array-empty-no-customer');
      setupHappyPathDraft(sale);

      await expect(
        service.chargeDraft(
          sale.id,
          'user-1',
          { payments: [] } as never,
          'idem-array-empty-no-customer',
        ),
      ).rejects.toThrow('CUSTOMER_REQUIRED_FOR_CREDIT');
    });

    it('accepts empty payments[] with customer and marks CREDIT', async () => {
      const sale = buildDraftSale(
        'sale-charge-array-empty-credit',
        'user-1',
        'customer-1',
      );
      setupHappyPathDraft(sale);

      const result = await service.chargeDraft(
        sale.id,
        'user-1',
        { payments: [] } as never,
        'idem-array-empty-credit',
      );

      expect(result.paymentStatus).toBe('CREDIT');
      expect(result.paidCents).toBe(0);
      expect(result.debtCents).toBe(2000);
    });

    it('rejects card-only overpay with PAYMENT_AMOUNT_INVALID', async () => {
      const sale = buildDraftSale(
        'sale-charge-array-card-overpay',
        'user-1',
        'customer-1',
      );
      setupHappyPathDraft(sale);

      await expect(
        service.chargeDraft(
          sale.id,
          'user-1',
          {
            payments: [
              { method: 'card_debit', amountCents: 2500, reference: 'REF-1' },
            ],
          } as never,
          'idem-array-card-overpay',
        ),
      ).rejects.toThrow('PAYMENT_AMOUNT_INVALID');
    });

    it('computes changeDueCents from aggregated payments', async () => {
      const sale = buildDraftSale(
        'sale-charge-array-change',
        'user-1',
        'customer-1',
      );
      setupHappyPathDraft(sale);

      const result = await service.chargeDraft(
        sale.id,
        'user-1',
        {
          payments: [
            { method: 'cash', amountCents: 1500 },
            { method: 'card_debit', amountCents: 1000, reference: 'REF-2' },
          ],
        } as never,
        'idem-array-change',
      );

      expect(result.paymentStatus).toBe('PAID');
      expect(result.changeDueCents).toBe(500);
    });

    it('uses stable idempotency hash for reordered payments[]', async () => {
      const sale = buildDraftSale(
        'sale-charge-array-idempotency',
        'user-1',
        'customer-1',
      );
      setupHappyPathDraft(sale);

      const replayPayload = {
        saleId: sale.id,
        folio: 'A-2605-000014',
        subtotalCents: 2000,
        discountCents: 0,
        totalCents: 2000,
        paidCents: 2000,
        debtCents: 0,
        changeDueCents: 0,
        paymentStatus: 'PAID' as const,
        confirmedAt: new Date().toISOString(),
      };

      const hashes = new Map<string, unknown>();
      saleRepo.acquireChargeIdempotency.mockImplementation(
        async (_saleId: string, _key: string, requestHash: string) => {
          if (hashes.has(requestHash)) {
            return { kind: 'replay', payload: replayPayload };
          }
          hashes.set(requestHash, true);
          return { kind: 'acquired', token: 'idem-row-stable' };
        },
      );

      await service.chargeDraft(
        sale.id,
        'user-1',
        {
          payments: [
            { method: 'cash', amountCents: 1000 },
            { method: 'card_debit', amountCents: 1000, reference: 'REF-A' },
          ],
        } as never,
        'idem-array-stable',
      );

      const replay = await service.chargeDraft(
        sale.id,
        'user-1',
        {
          payments: [
            { method: 'card_debit', amountCents: 1000, reference: 'REF-A' },
            { method: 'cash', amountCents: 1000 },
          ],
        } as never,
        'idem-array-stable',
      );

      expect(replay).toEqual(replayPayload);
    });

    it('confirms draft with cash payment and computes change', async () => {
      const sale = Sale.create({ id: 'sale-charge-1', userId: 'user-1' });
      sale.addItem({
        id: 'item-1',
        saleId: 'sale-charge-1',
        productId: 'prod-1',
        variantId: null,
        productName: 'Prod 1',
        variantName: null,
        quantity: 2,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });

      saleRepo.findByIdForUpdate.mockResolvedValue(sale);
      productsService.getProductInfoForSale.mockResolvedValue({
        unitPriceCents: 1000,
      });
      productsService.resolveListPrice.mockResolvedValue(1000);
      saleRepo.allocateNextFolio = jest
        .fn()
        .mockResolvedValue('A-2605-000001') as any;
      saleRepo.persistChargeConfirmation = jest
        .fn()
        .mockResolvedValue(undefined) as any;
      saleRepo.runInTransaction = jest
        .fn()
        .mockImplementation(async (cb: any) => cb()) as any;
      (saleRepo as any).decrementStockForCharge = jest
        .fn()
        .mockResolvedValue(undefined);

      const result = await (service as any).chargeDraft(
        'sale-charge-1',
        'user-1',
        { method: 'cash', amountCents: 2500 },
        'idem-not-used-pr2',
      );

      expect(result.totalCents).toBe(2000);
      expect(result.changeDueCents).toBe(500);
      expect(result.paymentStatus).toBe('PAID');
      expect(saleRepo.persistChargeConfirmation).toHaveBeenCalled();
    });

    it('rejects price mismatch with PRICE_OUT_OF_DATE', async () => {
      const sale = Sale.create({ id: 'sale-charge-2', userId: 'user-1' });
      sale.addItem({
        id: 'item-1',
        saleId: 'sale-charge-2',
        productId: 'prod-1',
        variantId: null,
        productName: 'Prod 1',
        variantName: null,
        quantity: 1,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });

      saleRepo.findByIdForUpdate.mockResolvedValue(sale);
      productsService.getProductInfoForSale.mockResolvedValue({
        unitPriceCents: 1200,
      });
      productsService.resolveListPrice.mockResolvedValue(1200);
      saleRepo.runInTransaction = jest
        .fn()
        .mockImplementation(async (cb: any) => cb()) as any;

      await expect(
        (service as any).chargeDraft(
          'sale-charge-2',
          'user-1',
          { method: 'cash', amountCents: 1200 },
          'idem-not-used-pr2',
        ),
      ).rejects.toThrow('PRICE_OUT_OF_DATE');
    });

    it('succeeds when item has per-line discount and list price is unchanged', async () => {
      const sale = Sale.fromPersistence({
        id: 'sale-charge-discount-ok',
        userId: 'user-1',
        status: 'DRAFT',
        createdAt: new Date(),
        updatedAt: new Date(),
        items: [
          {
            id: 'item-discount-ok',
            saleId: 'sale-charge-discount-ok',
            productId: 'prod-1',
            variantId: null,
            productName: 'Prod 1',
            variantName: null,
            quantity: 1,
            unitPriceCents: 63000,
            unitPriceCurrency: 'MXN',
            priceSource: 'default',
            discountType: 'percentage',
            discountValue: 10,
            discountAmountCents: 7000,
            prePriceCentsBeforeDiscount: 70000,
          },
        ],
      });

      saleRepo.findByIdForUpdate.mockResolvedValue(sale);
      productsService.getProductInfoForSale.mockResolvedValue({
        unitPriceCents: 70000,
      });
      saleRepo.allocateNextFolio.mockResolvedValue('A-2605-000014');
      saleRepo.persistChargeConfirmation.mockResolvedValue([]);
      productsService.decrementStockForCharge.mockResolvedValue([]);

      const result = await service.chargeDraft(
        sale.id,
        'user-1',
        { method: 'cash', amountCents: 63000 },
        'idem-discount-ok',
      );

      expect(result.totalCents).toBe(63000);
      expect(result.paymentStatus).toBe('PAID');
    });

    it('rejects when item has per-line discount and underlying price changed', async () => {
      const sale = Sale.fromPersistence({
        id: 'sale-charge-discount-stale',
        userId: 'user-1',
        status: 'DRAFT',
        createdAt: new Date(),
        updatedAt: new Date(),
        items: [
          {
            id: 'item-discount-stale',
            saleId: 'sale-charge-discount-stale',
            productId: 'prod-1',
            variantId: null,
            productName: 'Prod 1',
            variantName: null,
            quantity: 1,
            unitPriceCents: 63000,
            unitPriceCurrency: 'MXN',
            priceSource: 'default',
            discountType: 'percentage',
            discountValue: 10,
            discountAmountCents: 7000,
            prePriceCentsBeforeDiscount: 70000,
          },
        ],
      });

      saleRepo.findByIdForUpdate.mockResolvedValue(sale);
      productsService.getProductInfoForSale.mockResolvedValue({
        unitPriceCents: 80000,
      });

      await expect(
        service.chargeDraft(
          sale.id,
          'user-1',
          { method: 'cash', amountCents: 63000 },
          'idem-discount-stale',
        ),
      ).rejects.toMatchObject({ code: 'PRICE_OUT_OF_DATE' });
    });

    it('rejects credit with non-zero amount using INVALID_CREDIT_CHARGE', async () => {
      const sale = buildDraftSale(
        'sale-charge-credit-invalid-simple',
        'user-1',
        'customer-1',
      );
      saleRepo.findByIdForUpdate.mockResolvedValue(sale);
      productsService.getProductInfoForSale.mockResolvedValue({
        unitPriceCents: 1000,
      });

      await expect(
        service.chargeDraft(
          sale.id,
          'user-1',
          { method: 'credit', amountCents: 1000 },
          'idem-not-used-pr2',
        ),
      ).rejects.toThrow('INVALID_CREDIT_CHARGE');
    });

    it('accepts pure credit (amount 0), marks CREDIT and persists zero payment rows', async () => {
      const sale = buildDraftSale('sale-charge-credit', 'user-1', 'customer-1');
      saleRepo.findByIdForUpdate.mockResolvedValue(sale);
      productsService.getProductInfoForSale.mockResolvedValue({
        unitPriceCents: 1000,
      });
      productsService.decrementStockForCharge.mockResolvedValue([]);
      saleRepo.allocateNextFolio.mockResolvedValue('A-2605-000012');
      saleRepo.persistChargeConfirmation.mockResolvedValue([]);

      const result = await service.chargeDraft(
        sale.id,
        'user-1',
        { method: 'credit', amountCents: 0 },
        'idem-credit-ok',
      );

      expect(result.paymentStatus).toBe('CREDIT');
      expect(result.paidCents).toBe(0);
      expect(result.debtCents).toBe(2000);
      expect(saleRepo.persistChargeConfirmation).toHaveBeenCalledWith(
        expect.objectContaining({
          payments: [],
          paymentStatus: 'CREDIT',
          paidCents: 0,
          debtCents: 2000,
          userId: 'user-1',
        }),
      );
    });

    it('accepts partial non-credit payment and marks PARTIAL', async () => {
      const sale = buildDraftSale(
        'sale-charge-partial',
        'user-1',
        'customer-1',
      );
      saleRepo.findByIdForUpdate.mockResolvedValue(sale);
      productsService.getProductInfoForSale.mockResolvedValue({
        unitPriceCents: 1000,
      });
      productsService.decrementStockForCharge.mockResolvedValue([]);
      saleRepo.allocateNextFolio.mockResolvedValue('A-2605-000013');
      saleRepo.persistChargeConfirmation.mockResolvedValue([]);

      const result = await service.chargeDraft(
        sale.id,
        'user-1',
        { method: 'cash', amountCents: 1500 },
        'idem-partial-ok',
      );

      expect(result.paymentStatus).toBe('PARTIAL');
      expect(result.paidCents).toBe(1500);
      expect(result.debtCents).toBe(500);
    });

    it('keeps chargeDraft default dueDate rule as confirmedAt + 15 days when dueDate is omitted', async () => {
      const sale = buildDraftSale(
        'sale-charge-default-due-date',
        'user-1',
        'customer-1',
      );
      setupHappyPathDraft(sale);

      await service.chargeDraft(
        sale.id,
        'user-1',
        { method: 'cash', amountCents: 1500 },
        'idem-default-due-date',
      );

      const persistedInput =
        saleRepo.persistChargeConfirmation.mock.calls[0][0];
      const confirmedAt = persistedInput.confirmedAt;
      const expectedDueDate = new Date(confirmedAt);
      expectedDueDate.setDate(expectedDueDate.getDate() + 15);

      expect(persistedInput.dueDate).toEqual(expectedDueDate);
    });

    it('rejects credit with non-zero amount using INVALID_CREDIT_CHARGE (draft loaded)', async () => {
      const sale = buildDraftSale(
        'sale-charge-credit-invalid',
        'user-1',
        'customer-1',
      );
      saleRepo.findByIdForUpdate.mockResolvedValue(sale);
      productsService.getProductInfoForSale.mockResolvedValue({
        unitPriceCents: 1000,
      });

      await expect(
        service.chargeDraft(
          sale.id,
          'user-1',
          { method: 'credit', amountCents: 1 },
          'idem-credit-invalid',
        ),
      ).rejects.toThrow('INVALID_CREDIT_CHARGE');
    });

    it('rejects credit charge without customer using CUSTOMER_REQUIRED_FOR_CREDIT', async () => {
      const sale = buildDraftSale('sale-charge-credit-no-customer');
      saleRepo.findByIdForUpdate.mockResolvedValue(sale);
      productsService.getProductInfoForSale.mockResolvedValue({
        unitPriceCents: 1000,
      });

      await expect(
        service.chargeDraft(
          sale.id,
          'user-1',
          { method: 'credit', amountCents: 0 },
          'idem-credit-no-customer',
        ),
      ).rejects.toThrow('CUSTOMER_REQUIRED_FOR_CREDIT');
    });

    it('rejects partial charge without customer using CUSTOMER_REQUIRED_FOR_CREDIT', async () => {
      const sale = buildDraftSale('sale-charge-partial-no-customer');
      saleRepo.findByIdForUpdate.mockResolvedValue(sale);
      productsService.getProductInfoForSale.mockResolvedValue({
        unitPriceCents: 1000,
      });

      await expect(
        service.chargeDraft(
          sale.id,
          'user-1',
          { method: 'cash', amountCents: 1500 },
          'idem-partial-no-customer',
        ),
      ).rejects.toThrow('CUSTOMER_REQUIRED_FOR_CREDIT');
    });

    it('allows full payment without customer and keeps PAID', async () => {
      const sale = buildDraftSale('sale-charge-full-no-customer');
      saleRepo.findByIdForUpdate.mockResolvedValue(sale);
      productsService.getProductInfoForSale.mockResolvedValue({
        unitPriceCents: 1000,
      });
      productsService.decrementStockForCharge.mockResolvedValue([]);
      saleRepo.allocateNextFolio.mockResolvedValue('A-2605-000014');
      saleRepo.persistChargeConfirmation.mockResolvedValue([]);

      const result = await service.chargeDraft(
        sale.id,
        'user-1',
        { method: 'cash', amountCents: 2000 },
        'idem-full-no-customer',
      );

      expect(result.paymentStatus).toBe('PAID');
      expect(result.debtCents).toBe(0);
    });

    it('rejects card underpayment with PAYMENT_AMOUNT_INSUFFICIENT', async () => {
      const sale = buildDraftSale(
        'sale-charge-underpay',
        'user-1',
        'customer-1',
      );
      saleRepo.findByIdForUpdate.mockResolvedValue(sale);
      productsService.getProductInfoForSale.mockResolvedValue({
        unitPriceCents: 1000,
      });

      await expect(
        service.chargeDraft(
          sale.id,
          'user-1',
          { method: 'card_debit', amountCents: 1500 },
          'idem-underpay',
        ),
      ).rejects.toThrow('PAYMENT_AMOUNT_INSUFFICIENT');
    });

    it('rejects non-cash overpayment with PAYMENT_AMOUNT_INVALID', async () => {
      const sale = buildDraftSale('sale-charge-overpay');
      saleRepo.findByIdForUpdate.mockResolvedValue(sale);
      productsService.getProductInfoForSale.mockResolvedValue({
        unitPriceCents: 1000,
      });

      await expect(
        service.chargeDraft(
          sale.id,
          'user-1',
          { method: 'transfer', amountCents: 2500 },
          'idem-overpay',
        ),
      ).rejects.toThrow('PAYMENT_AMOUNT_INVALID');
    });

    it('rejects already confirmed sale with SALE_ALREADY_CONFIRMED', async () => {
      const sale = Sale.fromPersistence({
        id: 'sale-charge-confirmed',
        userId: 'user-1',
        status: 'CONFIRMED',
        createdAt: new Date(),
        updatedAt: new Date(),
        items: [
          {
            id: 'item-1',
            saleId: 'sale-charge-confirmed',
            productId: 'prod-1',
            variantId: null,
            productName: 'Prod 1',
            variantName: null,
            quantity: 2,
            unitPriceCents: 1000,
            unitPriceCurrency: 'MXN',
          },
        ],
      });

      saleRepo.findByIdForUpdate.mockResolvedValue(sale);

      await expect(
        service.chargeDraft(
          sale.id,
          'user-1',
          { method: 'cash', amountCents: 2000 },
          'idem-confirmed',
        ),
      ).rejects.toThrow('SALE_ALREADY_CONFIRMED');
    });

    it('accepts custom-priced item even when current list price changed', async () => {
      const sale = Sale.create({
        id: 'sale-charge-custom-price',
        userId: 'user-1',
      });
      sale.addItem({
        id: 'item-custom',
        saleId: sale.id,
        productId: 'prod-1',
        variantId: null,
        productName: 'Prod 1',
        variantName: null,
        quantity: 1,
        unitPriceCents: 500,
        unitPriceCurrency: 'MXN',
        originalPriceCents: 600,
        priceSource: 'custom',
        customPriceCents: 500,
      });

      saleRepo.findByIdForUpdate.mockResolvedValue(sale);
      saleRepo.allocateNextFolio.mockResolvedValue('A-2605-000011');
      saleRepo.persistChargeConfirmation.mockResolvedValue([]);
      productsService.decrementStockForCharge.mockResolvedValue([]);
      productsService.getProductInfoForSale.mockResolvedValue({
        unitPriceCents: 9999,
      });

      const result = await service.chargeDraft(
        sale.id,
        'user-1',
        { method: 'cash', amountCents: 500 },
        'idem-custom-price',
      );

      expect(result.totalCents).toBe(500);
      expect(productsService.getProductInfoForSale).not.toHaveBeenCalled();
    });

    it('subtotal uses post-line-discount unitPrice (C2 / previewTotals source of truth) for a discounted default-priced item', async () => {
      const sale = Sale.fromPersistence({
        id: 'sale-charge-discounted-default',
        userId: 'user-1',
        status: 'DRAFT',
        customerId: 'customer-1',
        createdAt: new Date(),
        updatedAt: new Date(),
        items: [
          {
            id: 'item-discounted-default',
            saleId: 'sale-charge-discounted-default',
            productId: 'prod-discounted',
            variantId: null,
            productName: 'Prod discounted',
            variantName: null,
            quantity: 2,
            unitPriceCents: 63000,
            unitPriceCurrency: 'MXN',
            priceSource: 'default',
            discountType: 'percentage',
            discountValue: 10,
            discountAmountCents: 7000,
            prePriceCentsBeforeDiscount: 70000,
          },
        ],
      });

      saleRepo.findByIdForUpdate.mockResolvedValue(sale);
      productsService.getProductInfoForSale.mockResolvedValue({
        unitPriceCents: 70000,
      });
      productsService.decrementStockForCharge.mockResolvedValue([]);
      saleRepo.allocateNextFolio.mockResolvedValue('A-2605-000015');
      saleRepo.persistChargeConfirmation.mockResolvedValue([]);

      await service.chargeDraft(
        sale.id,
        'user-1',
        { method: 'cash', amountCents: 126000 },
        'idem-charge-discounted-default',
      );

      expect(saleRepo.persistChargeConfirmation).toHaveBeenCalledWith(
        expect.objectContaining({
          // Work Unit 5 (C2) — sale-level view. `sale.previewTotals()` is the
          // single source of truth for both preview and charge paths.
          // Per-line discounts are baked into per-line `unitPriceCents`
          // (62900*2 = 126000 here), so `subtotalCents` = post-line-discount
          // line totals, and `discountCents` only carries the ORDER_DISCOUNT
          // term (zero in this test — no order promo).
          subtotalCents: 126000,
          discountCents: 0,
          totalCents: 126000,
        }),
      );
    });

    it('computes override subtotal with zero discount for custom-priced item', async () => {
      const sale = Sale.fromPersistence({
        id: 'sale-charge-custom-override',
        userId: 'user-1',
        status: 'DRAFT',
        customerId: 'customer-1',
        createdAt: new Date(),
        updatedAt: new Date(),
        items: [
          {
            id: 'item-custom-override',
            saleId: 'sale-charge-custom-override',
            productId: 'prod-custom',
            variantId: null,
            productName: 'Prod custom',
            variantName: null,
            quantity: 2,
            unitPriceCents: 90000,
            unitPriceCurrency: 'MXN',
            originalPriceCents: 80000,
            priceSource: 'custom',
            prePriceCentsBeforeDiscount: null,
          },
        ],
      });

      saleRepo.findByIdForUpdate.mockResolvedValue(sale);
      productsService.decrementStockForCharge.mockResolvedValue([]);
      saleRepo.allocateNextFolio.mockResolvedValue('A-2605-000016');
      saleRepo.persistChargeConfirmation.mockResolvedValue([]);

      await service.chargeDraft(
        sale.id,
        'user-1',
        { method: 'cash', amountCents: 180000 },
        'idem-charge-custom-override',
      );

      expect(saleRepo.persistChargeConfirmation).toHaveBeenCalledWith(
        expect.objectContaining({
          subtotalCents: 180000,
          discountCents: 0,
          totalCents: 180000,
        }),
      );
    });

    it('computes totals for mixed plain, discounted, and override items', async () => {
      const sale = Sale.fromPersistence({
        id: 'sale-charge-mixed-items',
        userId: 'user-1',
        status: 'DRAFT',
        customerId: 'customer-1',
        createdAt: new Date(),
        updatedAt: new Date(),
        items: [
          {
            id: 'item-plain',
            saleId: 'sale-charge-mixed-items',
            productId: 'prod-plain',
            variantId: null,
            productName: 'Prod plain',
            variantName: null,
            quantity: 1,
            unitPriceCents: 20000,
            unitPriceCurrency: 'MXN',
            priceSource: 'default',
          },
          {
            id: 'item-discount',
            saleId: 'sale-charge-mixed-items',
            productId: 'prod-discount',
            variantId: null,
            productName: 'Prod discount',
            variantName: null,
            quantity: 2,
            unitPriceCents: 63000,
            unitPriceCurrency: 'MXN',
            priceSource: 'default',
            discountType: 'percentage',
            discountValue: 10,
            discountAmountCents: 7000,
            prePriceCentsBeforeDiscount: 70000,
          },
          {
            id: 'item-override',
            saleId: 'sale-charge-mixed-items',
            productId: 'prod-override',
            variantId: null,
            productName: 'Prod override',
            variantName: null,
            quantity: 2,
            unitPriceCents: 90000,
            unitPriceCurrency: 'MXN',
            originalPriceCents: 80000,
            priceSource: 'custom',
            prePriceCentsBeforeDiscount: null,
          },
        ],
      });

      saleRepo.findByIdForUpdate.mockResolvedValue(sale);
      productsService.getProductInfoForSale.mockImplementation(
        async (productId: string) => {
          if (productId === 'prod-plain') return { unitPriceCents: 20000 };
          return { unitPriceCents: 70000 };
        },
      );
      productsService.decrementStockForCharge.mockResolvedValue([]);
      saleRepo.allocateNextFolio.mockResolvedValue('A-2605-000017');
      saleRepo.persistChargeConfirmation.mockResolvedValue([]);

      await service.chargeDraft(
        sale.id,
        'user-1',
        { method: 'cash', amountCents: 326000 },
        'idem-charge-mixed-items',
      );

      expect(saleRepo.persistChargeConfirmation).toHaveBeenCalledWith(
        expect.objectContaining({
          // Work Unit 5 (C2) — `sale.previewTotals()` is the single source
          // of truth. The item-discount line still has the 10% per-line
          // discount baked into `unitPriceCents=63000` so the post-line
          // subtotal is 20000+126000+180000=326000. discountCents only
          // carries the ORDER_DISCOUNT (zero here — no order promo).
          subtotalCents: 326000,
          totalCents: 326000,
          discountCents: 0,
        }),
      );
    });

    it('fails all-or-nothing when stock decrement rejects and avoids persistence', async () => {
      const sale = buildDraftSale('sale-charge-stock-fail');
      saleRepo.findByIdForUpdate.mockResolvedValue(sale);
      productsService.getProductInfoForSale.mockResolvedValue({
        unitPriceCents: 1000,
      });
      productsService.decrementStockForCharge.mockRejectedValue(
        new BusinessRuleViolationError(
          'STOCK_INSUFFICIENT_AT_CONFIRM',
          'STOCK_INSUFFICIENT_AT_CONFIRM',
        ),
      );

      await expect(
        service.chargeDraft(
          sale.id,
          'user-1',
          { method: 'cash', amountCents: 2000 },
          'idem-stock-fail',
        ),
      ).rejects.toThrow('STOCK_INSUFFICIENT_AT_CONFIRM');
      expect(saleRepo.persistChargeConfirmation).not.toHaveBeenCalled();
      expect(saleRepo.markChargeIdempotencySucceeded).not.toHaveBeenCalled();
    });

    it('replays stored response when idempotency key/hash already succeeded', async () => {
      const sale = buildDraftSale('sale-charge-replay');
      const replayPayload = {
        saleId: 'sale-charge-replay',
        folio: 'A-2605-000009',
        subtotalCents: 2000,
        discountCents: 0,
        totalCents: 2000,
        paidCents: 2000,
        debtCents: 0,
        changeDueCents: 0,
        paymentStatus: 'PAID',
        confirmedAt: new Date().toISOString(),
      };

      (saleRepo as any).acquireChargeIdempotency = jest.fn().mockResolvedValue({
        kind: 'replay',
        payload: replayPayload,
      });

      const result = await service.chargeDraft(
        sale.id,
        'user-1',
        { method: 'card_debit', amountCents: 2000 },
        'idem-replay',
      );

      expect(result).toEqual(replayPayload);
      expect(saleRepo.findByIdForUpdate).not.toHaveBeenCalled();
      expect(saleRepo.persistChargeConfirmation).not.toHaveBeenCalled();
      expect(saleRepo.runInTransaction).not.toHaveBeenCalled();
    });

    it('fails when idempotency key is reused with a different request hash', async () => {
      (saleRepo as any).acquireChargeIdempotency = jest
        .fn()
        .mockResolvedValue({ kind: 'conflict' });

      await expect(
        service.chargeDraft(
          'sale-charge-conflict',
          'user-1',
          { method: 'cash', amountCents: 2000 },
          'idem-conflict',
        ),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
    });

    it('fails when same idempotency key is already in flight', async () => {
      (saleRepo as any).acquireChargeIdempotency = jest
        .fn()
        .mockResolvedValue({ kind: 'in_flight' });

      await expect(
        service.chargeDraft(
          'sale-charge-flight',
          'user-1',
          { method: 'cash', amountCents: 2000 },
          'idem-flight',
        ),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_IN_FLIGHT' });
    });

    it('stores idempotent success payload after confirming charge', async () => {
      const sale = buildDraftSale('sale-charge-success');
      saleRepo.findByIdForUpdate.mockResolvedValue(sale);
      productsService.getProductInfoForSale.mockResolvedValue({
        unitPriceCents: 1000,
      });
      productsService.decrementStockForCharge.mockResolvedValue([]);
      saleRepo.allocateNextFolio.mockResolvedValue('A-2605-000010');
      saleRepo.persistChargeConfirmation.mockResolvedValue([]);
      (saleRepo as any).acquireChargeIdempotency = jest
        .fn()
        .mockResolvedValue({ kind: 'acquired', token: 'idem-row-1' });
      (saleRepo as any).markChargeIdempotencySucceeded = jest
        .fn()
        .mockResolvedValue(undefined);

      const result = await service.chargeDraft(
        sale.id,
        'user-1',
        { method: 'cash', amountCents: 2000 },
        'idem-success',
      );

      expect(
        (saleRepo as any).markChargeIdempotencySucceeded,
      ).toHaveBeenCalledWith('idem-row-1', sale.id, result);
    });

    it('propagates customerId and sellerUserId from the draft to persistChargeConfirmation', async () => {
      // Reproduction of the bug reported by the frontend:
      // A draft with an assigned customer (and optionally a seller) was losing
      // those references after chargeDraft because the service never forwarded
      // them to the repo, and the repo defensively overwrote them with null.
      const sale = buildDraftSale(
        'sale-charge-customer-propagation',
        'user-1',
        'customer-from-draft',
      );
      sale.assignSeller('seller-from-draft', 'user-1');
      setupHappyPathDraft(sale);

      await service.chargeDraft(
        sale.id,
        'user-1',
        { method: 'cash', amountCents: 2000 },
        'idem-customer-propagation',
      );

      expect(saleRepo.persistChargeConfirmation).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: 'customer-from-draft',
          sellerUserId: 'seller-from-draft',
        }),
      );
    });

    it('passes customerId: null when the draft has no customer (público en general)', async () => {
      const sale = buildDraftSale('sale-charge-no-customer', 'user-1', null);
      setupHappyPathDraft(sale);

      await service.chargeDraft(
        sale.id,
        'user-1',
        { method: 'cash', amountCents: 2000 },
        'idem-no-customer',
      );

      const call = saleRepo.persistChargeConfirmation.mock.calls[0]?.[0] as {
        customerId?: string | null;
      };
      expect(call.customerId).toBeNull();
    });
  });

  // ── Slice E.3 — sales orchestrator captures crossings ───────────────

  describe('Slice E.3 — chargeDraft stock-crossing capture', () => {
    const buildDraftSaleWithMultipleItems = (id: string) =>
      Sale.fromPersistence({
        id,
        userId: 'user-1',
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
            quantity: 2,
            unitPriceCents: 1000,
            unitPriceCurrency: 'MXN',
          },
          {
            id: `${id}-item-2`,
            saleId: id,
            productId: 'prod-2',
            variantId: 'var-1',
            productName: 'Prod 2',
            variantName: 'Red',
            quantity: 1,
            unitPriceCents: 2500,
            unitPriceCurrency: 'MXN',
          },
        ],
      });

    it('calls decrementStockForCharge with the per-item stockAdjustments array (E.3 wiring)', async () => {
      const sale = buildDraftSaleWithMultipleItems('sale-e3-multi');
      saleRepo.findByIdForUpdate.mockResolvedValue(sale);
      productsService.getProductInfoForSale.mockImplementation(
        async (productId: string) => {
          if (productId === 'prod-2') {
            return { unitPriceCents: 2500 };
          }
          return { unitPriceCents: 1000 };
        },
      );
      productsService.decrementStockForCharge.mockResolvedValue([]);
      saleRepo.allocateNextFolio.mockResolvedValue('A-2605-000050');
      saleRepo.persistChargeConfirmation.mockResolvedValue([]);

      await service.chargeDraft(
        sale.id,
        'user-1',
        { method: 'cash', amountCents: 4500 },
        'idem-e3-multi',
      );

      // One call, with one entry per sale item.
      expect(productsService.decrementStockForCharge).toHaveBeenCalledTimes(1);
      const [adjustments] =
        productsService.decrementStockForCharge.mock.calls[0];
      expect(adjustments).toEqual([
        { productId: 'prod-1', variantId: null, quantity: 2 },
        { productId: 'prod-2', variantId: 'var-1', quantity: 1 },
      ]);
    });

    it('runs decrementStockForCharge INSIDE runInTransaction (no in-tx network call escapes the tx boundary)', async () => {
      const sale = buildDraftSaleWithMultipleItems('sale-e3-in-tx');
      saleRepo.findByIdForUpdate.mockResolvedValue(sale);
      productsService.getProductInfoForSale.mockImplementation(
        async (productId: string) => {
          if (productId === 'prod-2') {
            return { unitPriceCents: 2500 };
          }
          return { unitPriceCents: 1000 };
        },
      );
      productsService.decrementStockForCharge.mockResolvedValue([]);
      saleRepo.allocateNextFolio.mockResolvedValue('A-2605-000051');
      saleRepo.persistChargeConfirmation.mockResolvedValue([]);

      await service.chargeDraft(
        sale.id,
        'user-1',
        { method: 'cash', amountCents: 4500 },
        'idem-e3-in-tx',
      );

      // The tx was opened exactly once.
      expect(saleRepo.runInTransaction).toHaveBeenCalledTimes(1);
      // decrementStockForCharge was invoked during the tx body (its
      // call count is 1, observed AFTER runInTransaction resolves).
      expect(productsService.decrementStockForCharge).toHaveBeenCalledTimes(1);
    });

    it('does NOT call decrementStockForCharge when runInTransaction rejects (rollback → no crossings emitted)', async () => {
      const sale = buildDraftSaleWithMultipleItems('sale-e3-rollback');
      saleRepo.findByIdForUpdate.mockResolvedValue(sale);
      productsService.getProductInfoForSale.mockImplementation(
        async (productId: string) => {
          if (productId === 'prod-2') {
            return { unitPriceCents: 2500 };
          }
          return { unitPriceCents: 1000 };
        },
      );
      // Simulate the decrement throwing STOCK_INSUFFICIENT_AT_CONFIRM
      // mid-tx. The outer runInTransaction rejects; nothing leaks out.
      productsService.decrementStockForCharge.mockRejectedValue(
        new Error('STOCK_INSUFFICIENT_AT_CONFIRM'),
      );
      // Override runInTransaction to actually throw (the default mock
      // resolves, so the .rejects expectation below wouldn't fire).
      saleRepo.runInTransaction.mockImplementation(async (cb: any) => {
        return cb();
      });

      await expect(
        service.chargeDraft(
          sale.id,
          'user-1',
          { method: 'cash', amountCents: 4500 },
          'idem-e3-rollback',
        ),
      ).rejects.toThrow('STOCK_INSUFFICIENT_AT_CONFIRM');

      // Mark idempotency as NOT succeeded on reject.
      expect(saleRepo.markChargeIdempotencySucceeded).not.toHaveBeenCalled();
      // No outbox writes occurred (no sale.confirmed, no payment events).
      const eventTypes = outboxWriter.publish.mock.calls.map(
        (args) => args[4],
      );
      expect(eventTypes).not.toContain('sale.confirmed');
      expect(eventTypes).not.toContain('sale.payment.received');
    });
  });

  describe('cancelSale', () => {
    const buildConfirmedSaleForCancel = (
      saleId = 'sale-cancel-happy',
      paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT' = 'PARTIAL',
      deliveryStatus: 'PENDING' | 'SHIPPED' | 'DELIVERED' = 'PENDING',
      status: 'CONFIRMED' | 'CANCELED' = 'CONFIRMED',
    ) =>
      Sale.fromPersistence({
        id: saleId,
        userId: 'user-1',
        status,
        channel: 'POS',
        register: 'Principal',
        deliveryStatus,
        customerId: 'customer-1',
        items: [
          {
            id: `${saleId}-item-1`,
            saleId,
            productId: 'prod-1',
            variantId: 'var-1',
            productName: 'Prod 1',
            variantName: 'Var 1',
            quantity: 2,
            unitPriceCents: 2500,
            unitPriceCurrency: 'MXN',
          },
        ],
        confirmedAt: new Date('2026-06-23T10:00:00.000Z'),
        folio: 'A-202606-000126',
        totalCents: 5000,
        paidCents: paymentStatus === 'CREDIT' ? 0 : 4500,
        debtCents: paymentStatus === 'CREDIT' ? 5000 : 500,
        changeDueCents: 300,
        paymentStatus,
        canceledAt:
          status === 'CANCELED'
            ? new Date('2026-06-23T12:00:00.000Z')
            : undefined,
        cancelReason: status === 'CANCELED' ? 'ORDER_ERROR' : undefined,
        canceledByUserId: status === 'CANCELED' ? 'user-1' : undefined,
        createdAt: new Date('2026-06-23T09:55:00.000Z'),
        updatedAt: new Date('2026-06-23T10:00:00.000Z'),
      });

    it('cancels a confirmed non-delivered sale with restock, refund audit, and outbox', async () => {
      const sale = buildConfirmedSaleForCancel();
      saleRepo.findByIdForUpdate.mockResolvedValue(sale);
      saleRepo.findOneWithRelations.mockResolvedValue({
        id: sale.id,
        folio: sale.folio ?? null,
        status: 'CONFIRMED',
        channel: 'POS',
        register: 'Principal',
        confirmedAt: sale.confirmedAt ?? null,
        dueDate: null,
        createdAt: new Date('2026-06-23T09:55:00.000Z'),
        subtotalCents: 5000,
        discountCents: 0,
        totalCents: 5000,
        paidCents: 4500,
        debtCents: 500,
        changeDueCents: 300,
        paymentStatus: 'PARTIAL',
        deliveryStatus: 'PENDING',
        customer: { id: 'customer-1', name: 'Ana' },
        cashier: { id: 'user-1', name: 'Caja 1' },
        seller: null,
        items: [],
        payments: [
          {
            paymentId: 'payment-1',
            method: 'cash',
            amountCents: 4000,
            tenderedCents: 4000,
            changeCents: 0,
            reference: null,
            paidAt: new Date('2026-06-23T10:00:00.000Z'),
            createdAt: new Date('2026-06-23T10:00:00.000Z'),
            userId: 'user-1',
            user: { id: 'user-1', name: 'Caja 1' },
          },
          {
            paymentId: 'payment-2',
            method: 'transfer',
            amountCents: 800,
            tenderedCents: 800,
            changeCents: 300,
            reference: 'TRX-1',
            paidAt: new Date('2026-06-23T10:01:00.000Z'),
            createdAt: new Date('2026-06-23T10:01:00.000Z'),
            userId: 'user-1',
            user: { id: 'user-1', name: 'Caja 1' },
          },
        ],
      });

      const result = await service.cancelSale(sale.id, 'user-1', {
        reason: 'ORDER_ERROR',
      });

      expect(result).toEqual(
        expect.objectContaining({
          saleId: sale.id,
          status: 'CANCELED',
          refundedCents: 4500,
          restockedItems: [
            { productId: 'prod-1', variantId: 'var-1', quantity: 2 },
          ],
          canceledAt: expect.any(String),
        }),
      );
      expect(productsService.incrementStockForRestock).toHaveBeenCalledWith([
        { productId: 'prod-1', variantId: 'var-1', quantity: 2 },
      ]);
      expect(saleRepo.persistCancellation).toHaveBeenCalledWith(
        expect.objectContaining({
          id: sale.id,
          status: 'CANCELED',
          cancelReason: 'ORDER_ERROR',
        }),
        [
          {
            salePaymentId: 'payment-1',
            method: 'cash',
            amountCents: 4000,
            reason: 'ORDER_ERROR',
          },
          {
            salePaymentId: 'payment-2',
            method: 'transfer',
            amountCents: 500,
            reason: 'ORDER_ERROR',
          },
        ],
      );
      expect(outboxWriter.publish).toHaveBeenCalledWith(
        expect.anything(),
        'tenant-1',
        'Sale',
        sale.id,
        'sale.canceled',
        expect.objectContaining({
          saleId: sale.id,
          tenantId: 'tenant-1',
          actorId: 'user-1',
          folio: 'A-202606-000126',
          reason: 'ORDER_ERROR',
          refundedCents: 4500,
          restockedItems: [
            { productId: 'prod-1', variantId: 'var-1', quantity: 2 },
          ],
          canceledAt: expect.any(String),
        }),
      );
    });

    it('replays the stored cancellation result without duplicate side effects', async () => {
      saleRepo.acquireCancellationIdempotency.mockResolvedValueOnce({
        kind: 'replay',
        payload: {
          saleId: 'sale-cancel-replay',
          status: 'CANCELED',
          refundedCents: 4500,
          restockedItems: [
            { productId: 'prod-1', variantId: 'var-1', quantity: 2 },
          ],
          canceledAt: '2026-06-23T12:00:00.000Z',
        },
      });

      const result = await service.cancelSale('sale-cancel-replay', 'user-1', {
        reason: 'ORDER_ERROR',
      });

      expect(result).toEqual({
        saleId: 'sale-cancel-replay',
        status: 'CANCELED',
        refundedCents: 4500,
        restockedItems: [
          { productId: 'prod-1', variantId: 'var-1', quantity: 2 },
        ],
        canceledAt: '2026-06-23T12:00:00.000Z',
      });
      expect(saleRepo.findByIdForUpdate).not.toHaveBeenCalled();
      expect(productsService.incrementStockForRestock).not.toHaveBeenCalled();
      expect(saleRepo.persistCancellation).not.toHaveBeenCalled();
      expect(outboxWriter.publish).not.toHaveBeenCalled();
    });

    it('returns the existing canceled outcome without double restock or refund when the row is already canceled', async () => {
      const sale = buildConfirmedSaleForCancel(
        'sale-cancel-already-canceled',
        'PARTIAL',
        'PENDING',
        'CANCELED',
      );
      saleRepo.findByIdForUpdate.mockResolvedValue(sale);

      const result = await service.cancelSale(sale.id, 'user-1', {
        reason: 'ORDER_ERROR',
      });

      expect(result).toEqual({
        saleId: sale.id,
        status: 'CANCELED',
        refundedCents: 4500,
        restockedItems: [
          { productId: 'prod-1', variantId: 'var-1', quantity: 2 },
        ],
        canceledAt: '2026-06-23T12:00:00.000Z',
      });
      expect(productsService.incrementStockForRestock).not.toHaveBeenCalled();
      expect(saleRepo.persistCancellation).not.toHaveBeenCalled();
      expect(outboxWriter.publish).not.toHaveBeenCalled();
      expect(saleRepo.markCancellationIdempotencySucceeded).toHaveBeenCalledWith(
        'cancel-idem-token',
        sale.id,
        result,
      );
    });

    it('cancels credit sales with zero refund rows and no payment detail lookup', async () => {
      const sale = buildConfirmedSaleForCancel('sale-cancel-credit', 'CREDIT');
      saleRepo.findByIdForUpdate.mockResolvedValue(sale);

      const result = await service.cancelSale(sale.id, 'user-1', {
        reason: 'CUSTOMER_REQUEST',
      });

      expect(result).toEqual(
        expect.objectContaining({
          saleId: sale.id,
          status: 'CANCELED',
          refundedCents: 0,
        }),
      );
      expect(saleRepo.findOneWithRelations).not.toHaveBeenCalled();
      expect(saleRepo.persistCancellation).toHaveBeenCalledWith(
        expect.objectContaining({
          id: sale.id,
          status: 'CANCELED',
          paymentStatus: 'CREDIT',
          debtCents: 0,
        }),
        [],
      );
      expect(outboxWriter.publish).toHaveBeenCalledWith(
        expect.anything(),
        'tenant-1',
        'Sale',
        sale.id,
        'sale.canceled',
        expect.objectContaining({
          refundedCents: 0,
          reason: 'CUSTOMER_REQUEST',
        }),
      );
    });

    it('propagates the shipped cancellation guard without side effects', async () => {
      const sale = buildConfirmedSaleForCancel(
        'sale-cancel-shipped',
        'PARTIAL',
        'SHIPPED',
      );
      saleRepo.findByIdForUpdate.mockResolvedValue(sale);

      await expect(
        service.cancelSale(sale.id, 'user-1', { reason: 'ORDER_ERROR' }),
      ).rejects.toThrow('SALE_DELIVERED_CANNOT_CANCEL');

      expect(productsService.incrementStockForRestock).not.toHaveBeenCalled();
      expect(saleRepo.persistCancellation).not.toHaveBeenCalled();
      expect(outboxWriter.publish).not.toHaveBeenCalled();
    });

    it('propagates the delivered cancellation guard without side effects', async () => {
      const sale = buildConfirmedSaleForCancel(
        'sale-cancel-delivered',
        'PARTIAL',
        'DELIVERED',
      );
      saleRepo.findByIdForUpdate.mockResolvedValue(sale);

      await expect(
        service.cancelSale(sale.id, 'user-1', { reason: 'ORDER_ERROR' }),
      ).rejects.toThrow('SALE_DELIVERED_CANNOT_CANCEL');

      expect(productsService.incrementStockForRestock).not.toHaveBeenCalled();
      expect(saleRepo.persistCancellation).not.toHaveBeenCalled();
      expect(outboxWriter.publish).not.toHaveBeenCalled();
    });

    it('cancels when actor differs from sale creator — tenant scope is sufficient (CRITICAL-2)', async () => {
      // sale.userId = 'user-1' (original cashier), actorId = 'admin-actor'
      // Tenant isolation is enforced by the tenant-scoped findByIdForUpdate;
      // RBAC (delete:Sale / sales:write) is enforced at the controller layer.
      // The ownership check (sale.userId !== actorId) must NOT block this path.
      // Uses CREDIT so refundedCents=0 — findOneWithRelations is skipped.
      const sale = buildConfirmedSaleForCancel('sale-cancel-admin', 'CREDIT');
      saleRepo.findByIdForUpdate.mockResolvedValue(sale);

      const result = await service.cancelSale(sale.id, 'admin-actor', {
        reason: 'ORDER_ERROR',
      });

      expect(result).toMatchObject({ saleId: sale.id, status: 'CANCELED' });
      expect(productsService.incrementStockForRestock).toHaveBeenCalledWith([
        { productId: 'prod-1', variantId: 'var-1', quantity: 2 },
      ]);
      expect(saleRepo.persistCancellation).toHaveBeenCalled();
    });

    it('rejects when sale is not found in actor tenant — cross-tenant isolation stays intact (CRITICAL-2)', async () => {
      // findByIdForUpdate returns null when the sale belongs to a different
      // tenant (tenant-scoped client filters it out). This must still reject.
      saleRepo.findByIdForUpdate.mockResolvedValue(null);

      await expect(
        service.cancelSale('sale-other-tenant', 'admin-actor', {
          reason: 'ORDER_ERROR',
        }),
      ).rejects.toThrow('SALE_NOT_FOUND');

      expect(productsService.incrementStockForRestock).not.toHaveBeenCalled();
      expect(saleRepo.persistCancellation).not.toHaveBeenCalled();
    });
  });

  describe('confirmBotSale', () => {
    const botSaleInput = {
      cashierUserId: 'user-bot-cashier',
      customerId: 'customer-1',
      shippingAddressId: 'shipping-1',
      items: [
        {
          productId: 'prod-1',
          variantId: 'var-1',
          productName: 'Prod 1',
          variantName: '3 kg',
          quantity: 2,
          unitPriceCents: 1000,
        },
      ],
    };

    const setupConfirmBotSaleHappyPath = () => {
      productsService.getApplicablePrices.mockResolvedValue([
        {
          priceListId: 'price-list-1',
          priceListName: 'PUBLICO',
          priceCents: 1000,
        },
      ]);
      productsService.decrementStockForCharge.mockResolvedValue([]);
      saleRepo.save.mockImplementation(async (sale) => sale);
      saleRepo.allocateNextFolio.mockResolvedValue('A-2606-000001');
      saleRepo.persistChargeConfirmation.mockResolvedValue([]);
    };

    it('confirms bot sale in one transaction with stock, folio, seller attribution, and default credit due date', async () => {
      setupConfirmBotSaleHappyPath();

      const result = await service.confirmBotSale(botSaleInput);

      expect(saleRepo.runInTransaction).toHaveBeenCalledTimes(1);
      expect(productsService.getApplicablePrices).toHaveBeenCalledWith(
        'prod-1',
        'var-1',
        2,
      );
      expect(saleRepo.save).toHaveBeenCalledTimes(1);
      expect(productsService.decrementStockForCharge).toHaveBeenCalledWith([
        {
          productId: 'prod-1',
          variantId: 'var-1',
          quantity: 2,
        },
      ]);
      expect(saleRepo.persistChargeConfirmation).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-bot-cashier',
          customerId: 'customer-1',
          sellerUserId: 'user-bot-cashier',
          channel: 'ONLINE',
          deliveryStatus: 'PENDING',
          paymentStatus: 'CREDIT',
          paidCents: 0,
          debtCents: 2000,
          totalCents: 2000,
          payments: [],
          folio: 'A-2606-000001',
        }),
      );

      const persistedInput = saleRepo.persistChargeConfirmation.mock
        .calls[0]?.[0] as {
        confirmedAt: Date;
        dueDate: Date | null;
      };
      const expectedDueDate = new Date(persistedInput.confirmedAt);
      expectedDueDate.setDate(expectedDueDate.getDate() + 15);
      expect(persistedInput.dueDate).toEqual(expectedDueDate);

      expect(outboxWriter.publish).toHaveBeenCalledTimes(1);
      expect(outboxWriter.publish).toHaveBeenCalledWith(
        expect.anything(),
        'tenant-1',
        'Sale',
        result.saleId,
        'sale.confirmed',
        {
          saleId: result.saleId,
          folio: 'A-2606-000001',
          tenantId: 'tenant-1',
          actorId: 'user-bot-cashier',
          totalCents: 2000,
          paidCents: 0,
          debtCents: 2000,
          paymentStatus: 'CREDIT',
          confirmedAt: expect.any(String),
        },
      );

      const transactionCallOrder = saleRepo.runInTransaction.mock
        .invocationCallOrder[0];
      expect(
        productsService.getApplicablePrices.mock.invocationCallOrder[0],
      ).toBeGreaterThan(transactionCallOrder);
      expect(saleRepo.save.mock.invocationCallOrder[0]).toBeGreaterThan(
        transactionCallOrder,
      );
      expect(
        productsService.decrementStockForCharge.mock.invocationCallOrder[0],
      ).toBeGreaterThan(transactionCallOrder);
      expect(
        saleRepo.persistChargeConfirmation.mock.invocationCallOrder[0],
      ).toBeGreaterThan(transactionCallOrder);
      expect(outboxWriter.publish.mock.invocationCallOrder[0]).toBeGreaterThan(
        transactionCallOrder,
      );

      expect(result).toEqual({
        saleId: expect.any(String),
        folio: 'A-2606-000001',
        paymentStatus: 'CREDIT',
        channel: 'ONLINE',
        deliveryStatus: 'PENDING',
        totalCents: 2000,
        paidCents: 0,
        debtCents: 2000,
        confirmedAt: expect.any(String),
      });
    });

    it('rejects stale bot prices before stock, folio, persistence, or outbox side effects', async () => {
      let priceValidationRanInsideTransaction = false;

      saleRepo.runInTransaction.mockImplementation(async (callback: any) => {
        priceValidationRanInsideTransaction = true;
        try {
          return await callback();
        } finally {
          priceValidationRanInsideTransaction = false;
        }
      });
      productsService.getApplicablePrices.mockImplementation(async () => {
        expect(priceValidationRanInsideTransaction).toBe(true);

        return [
          {
            priceListId: 'price-list-1',
            priceListName: 'PUBLICO',
            priceCents: 1250,
          },
        ];
      });

      await expect(service.confirmBotSale(botSaleInput)).rejects.toMatchObject({
        code: 'PRICE_OUT_OF_DATE',
      });

      expect(saleRepo.runInTransaction).toHaveBeenCalledTimes(1);
      expect(productsService.getApplicablePrices).toHaveBeenCalledTimes(1);
      expect(
        productsService.getApplicablePrices.mock.results[0]?.type,
      ).toBe('return');
      expect(
        productsService.getApplicablePrices.mock.invocationCallOrder[0],
      ).toBeGreaterThan(
        saleRepo.runInTransaction.mock.invocationCallOrder[0],
      );
      expect(saleRepo.save).not.toHaveBeenCalled();
      expect(productsService.decrementStockForCharge).not.toHaveBeenCalled();
      expect(saleRepo.allocateNextFolio).not.toHaveBeenCalled();
      expect(saleRepo.persistChargeConfirmation).not.toHaveBeenCalled();
      expect(outboxWriter.publish).not.toHaveBeenCalled();
    });

    it('publishes a plain-object sale.confirmed payload with the required fields', async () => {
      setupConfirmBotSaleHappyPath();

      const result = await service.confirmBotSale(botSaleInput);
      const payload = outboxWriter.publish.mock.calls[0]?.[5] as Record<
        string,
        unknown
      >;

      expect(Object.getPrototypeOf(payload)).toBe(Object.prototype);
      expect(payload).toEqual({
        saleId: result.saleId,
        folio: 'A-2606-000001',
        tenantId: 'tenant-1',
        actorId: 'user-bot-cashier',
        totalCents: 2000,
        paidCents: 0,
        debtCents: 2000,
        paymentStatus: 'CREDIT',
        confirmedAt: expect.any(String),
      });
    });

    it('emits only sale.confirmed for zero-payment credit bot sales', async () => {
      setupConfirmBotSaleHappyPath();

      await service.confirmBotSale(botSaleInput);

      const publishedEventTypes = outboxWriter.publish.mock.calls.map(
        (args) => args[4],
      );
      expect(publishedEventTypes).toEqual(['sale.confirmed']);
      expect(publishedEventTypes).not.toContain('sale.payment.received');
      expect(publishedEventTypes).not.toContain('sale.fully.paid');
    });
  });

  describe('item discount use-cases', () => {
    it('applies item discount and emits event', async () => {
      const sale = Sale.create({ id: 'sale-discount', userId: 'user-1' });
      sale.addItem({
        id: 'item-1',
        saleId: 'sale-discount',
        productId: 'prod-1',
        variantId: null,
        productName: 'Prod',
        variantName: null,
        quantity: 1,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });
      saleRepo.findById.mockResolvedValue(sale);

      const result = await service.applyItemDiscount(
        'sale-discount',
        'item-1',
        {
          type: 'percentage',
          percent: 15,
          discountTitle: 'promo',
        },
        'user-1',
      );

      expect(result.items[0].discountType).toBe('percentage');
      expect(result.items[0].discountTitle).toBe('promo');
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'sale.item.discount.applied',
        expect.objectContaining({ saleId: 'sale-discount', itemId: 'item-1' }),
      );
    });

    it('removes item discount and emits event', async () => {
      const sale = Sale.create({ id: 'sale-discount-2', userId: 'user-1' });
      sale.addItem({
        id: 'item-1',
        saleId: 'sale-discount-2',
        productId: 'prod-1',
        variantId: null,
        productName: 'Prod',
        variantName: null,
        quantity: 1,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });
      sale.applyItemDiscount('item-1', { type: 'amount', amountCents: 100 });
      saleRepo.findById.mockResolvedValue(sale);

      const result = await service.removeItemDiscount(
        'sale-discount-2',
        'item-1',
        'user-1',
      );
      expect(result.items[0].discountType).toBeNull();
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'sale.item.discount.removed',
        expect.objectContaining({
          saleId: 'sale-discount-2',
          itemId: 'item-1',
        }),
      );
    });
  });

  describe('global discount use-cases', () => {
    it('applies global discount, emits per-item applied events, and returns skippedItems', async () => {
      const sale = Sale.create({ id: 'sale-global', userId: 'user-1' });
      sale.addItem({
        id: 'item-eligible',
        saleId: 'sale-global',
        productId: 'prod-1',
        variantId: null,
        productName: 'Prod 1',
        variantName: null,
        quantity: 1,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });
      sale.addItem({
        id: 'item-skipped',
        saleId: 'sale-global',
        productId: 'prod-2',
        variantId: null,
        productName: 'Prod 2',
        variantName: null,
        quantity: 1,
        unitPriceCents: 300,
        unitPriceCurrency: 'MXN',
      });
      saleRepo.findById.mockResolvedValue(sale);

      const result = await service.applyGlobalDiscount(
        'sale-global',
        { type: 'amount', amountCents: 500 },
        'user-1',
      );

      expect(result.skippedItems).toEqual([
        { itemId: 'item-skipped', reason: 'DISCOUNT_AMOUNT_INVALID' },
      ]);
      expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'sale.item.discount.applied',
        expect.objectContaining({
          saleId: 'sale-global',
          itemId: 'item-eligible',
        }),
      );
    });

    it('throws SALE_NOT_FOUND when sale does not exist', async () => {
      saleRepo.findById.mockResolvedValue(null);

      await expect(
        service.applyGlobalDiscount(
          'missing-sale',
          { type: 'percentage', percent: 10 },
          'user-1',
        ),
      ).rejects.toThrow('SALE_NOT_FOUND');
    });

    it('throws SALE_NOT_DRAFT when sale status is not draft', async () => {
      const sale = Sale.fromPersistence({
        id: 'sale-non-draft',
        userId: 'user-1',
        status: 'DRAFT',
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      Object.defineProperty(sale, 'status', { value: 'CLOSED' });
      saleRepo.findById.mockResolvedValue(sale);

      await expect(
        service.applyGlobalDiscount(
          'sale-non-draft',
          { type: 'percentage', percent: 10 },
          'user-1',
        ),
      ).rejects.toThrow('SALE_NOT_DRAFT');
    });

    it('throws SALE_UPDATE_FORBIDDEN when actor does not own sale', async () => {
      const sale = Sale.create({ id: 'sale-owned', userId: 'user-1' });
      saleRepo.findById.mockResolvedValue(sale);

      await expect(
        service.applyGlobalDiscount(
          'sale-owned',
          { type: 'percentage', percent: 10 },
          'user-2',
        ),
      ).rejects.toThrow('SALE_UPDATE_FORBIDDEN');
    });

    it('skips already-discounted items when strategy is skip and only emits events for newly discounted', async () => {
      const sale = Sale.create({ id: 'sale-skip-strat', userId: 'user-1' });
      sale.addItem({
        id: 'item-has-discount',
        saleId: 'sale-skip-strat',
        productId: 'prod-1',
        variantId: null,
        productName: 'Prod 1',
        variantName: null,
        quantity: 1,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });
      sale.addItem({
        id: 'item-no-discount',
        saleId: 'sale-skip-strat',
        productId: 'prod-2',
        variantId: null,
        productName: 'Prod 2',
        variantName: null,
        quantity: 1,
        unitPriceCents: 2000,
        unitPriceCurrency: 'MXN',
      });
      // Apply individual discount to first item
      sale.applyItemDiscount('item-has-discount', {
        type: 'percentage',
        percent: 10,
      });
      saleRepo.findById.mockResolvedValue(sale);

      const result = await service.applyGlobalDiscount(
        'sale-skip-strat',
        { type: 'percentage', percent: 20, strategy: 'skip' },
        'user-1',
      );

      // First item skipped — keeps its 10% discount
      expect(result.skippedItems).toEqual(
        expect.arrayContaining([
          { itemId: 'item-has-discount', reason: 'ALREADY_DISCOUNTED' },
        ]),
      );
      expect(result.sale.items[0].discountValue).toBe(10);
      expect(result.sale.items[0].unitPriceCents).toBe(900);

      // Second item gets the 20% global discount
      expect(result.sale.items[1].discountValue).toBe(20);
      expect(result.sale.items[1].unitPriceCents).toBe(1600);

      // Only one event emitted (for the item that received the discount)
      expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'sale.item.discount.applied',
        expect.objectContaining({
          saleId: 'sale-skip-strat',
          itemId: 'item-no-discount',
        }),
      );
    });

    it('removes global discount and emits removed event for previously discounted items only', async () => {
      const sale = Sale.create({ id: 'sale-remove-global', userId: 'user-1' });
      sale.addItem({
        id: 'item-discounted',
        saleId: 'sale-remove-global',
        productId: 'prod-1',
        variantId: null,
        productName: 'Prod 1',
        variantName: null,
        quantity: 1,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });
      sale.addItem({
        id: 'item-not-discounted',
        saleId: 'sale-remove-global',
        productId: 'prod-2',
        variantId: null,
        productName: 'Prod 2',
        variantName: null,
        quantity: 1,
        unitPriceCents: 800,
        unitPriceCurrency: 'MXN',
      });
      sale.applyItemDiscount('item-discounted', {
        type: 'amount',
        amountCents: 100,
      });
      saleRepo.findById.mockResolvedValue(sale);

      const result = await service.removeGlobalDiscount(
        'sale-remove-global',
        'user-1',
      );

      expect(result.items[0].discountType).toBeNull();
      expect(result.items[1].discountType).toBeNull();
      expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'sale.item.discount.removed',
        expect.objectContaining({
          saleId: 'sale-remove-global',
          itemId: 'item-discounted',
        }),
      );
    });

    it('removeGlobalDiscount is idempotent when no discounts exist', async () => {
      const sale = Sale.create({
        id: 'sale-remove-idempotent',
        userId: 'user-1',
      });
      sale.addItem({
        id: 'item-plain',
        saleId: 'sale-remove-idempotent',
        productId: 'prod-1',
        variantId: null,
        productName: 'Prod 1',
        variantName: null,
        quantity: 1,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });
      saleRepo.findById.mockResolvedValue(sale);

      const result = await service.removeGlobalDiscount(
        'sale-remove-idempotent',
        'user-1',
      );

      expect(result.items[0].discountType).toBeNull();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('openDraft', () => {
    it('should create a new draft sale and emit event', async () => {
      const userId = 'user-1';

      const result = await service.openDraft(userId);

      expect(result).toMatchObject({
        userId,
        status: 'DRAFT',
        items: [],
      });
      expect(result.id).toBeDefined();
      expect(saleRepo.save).toHaveBeenCalledWith(expect.any(Sale));
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'sale.draft.opened',
        expect.objectContaining({
          saleId: result.id,
          userId,
        }),
      );
    });
  });

  describe('addItem', () => {
    it('should add item to draft with price snapshot and emit event', async () => {
      const saleId = 'sale-1';
      const sale = Sale.create({ id: saleId, userId: 'user-1' });

      saleRepo.findById.mockResolvedValue(sale);
      productsService.getProductInfoForSale.mockResolvedValue({
        productId: 'prod-1',
        productName: 'Aspirina',
        variantId: null,
        variantName: null,
        unitPriceCents: 5000,
      });
      productsService.checkStockAvailability.mockResolvedValue({
        available: true,
        currentStock: 100,
      });

      const result = await service.addItem(saleId, 'user-1', {
        productId: 'prod-1',
        variantId: null,
        quantity: 2,
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        productId: 'prod-1',
        productName: 'Aspirina',
        variantId: null,
        quantity: 2,
        unitPriceCents: 5000,
      });
      expect(saleRepo.save).toHaveBeenCalledWith(expect.any(Sale));
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'sale.item.added',
        expect.objectContaining({
          saleId,
          productId: 'prod-1',
          quantity: 2,
        }),
      );
    });

    it('should reject when sale does not exist', async () => {
      saleRepo.findById.mockResolvedValue(null);

      await expect(
        service.addItem('nonexistent', 'user-1', {
          productId: 'prod-1',
          variantId: null,
          quantity: 1,
        }),
      ).rejects.toThrow(EntityNotFoundError);
    });

    it('should reject when user does not own the sale', async () => {
      const sale = Sale.create({ id: 'sale-2', userId: 'user-1' });
      saleRepo.findById.mockResolvedValue(sale);

      await expect(
        service.addItem('sale-2', 'user-2', {
          productId: 'prod-1',
          variantId: null,
          quantity: 1,
        }),
      ).rejects.toThrow(BusinessRuleViolationError);
      await expect(
        service.addItem('sale-2', 'user-2', {
          productId: 'prod-1',
          variantId: null,
          quantity: 1,
        }),
      ).rejects.toThrow(/not own this sale/);
    });

    it('should reject when stock is insufficient', async () => {
      const sale = Sale.create({ id: 'sale-3', userId: 'user-1' });
      saleRepo.findById.mockResolvedValue(sale);

      productsService.getProductInfoForSale.mockResolvedValue({
        productId: 'prod-2',
        productName: 'Limited Item',
        variantId: null,
        variantName: null,
        unitPriceCents: 10000,
      });

      productsService.checkStockAvailability.mockResolvedValue({
        available: false,
        currentStock: 3,
      });

      await expect(
        service.addItem('sale-3', 'user-1', {
          productId: 'prod-2',
          variantId: null,
          quantity: 10,
        }),
      ).rejects.toThrow(BusinessRuleViolationError);
      await expect(
        service.addItem('sale-3', 'user-1', {
          productId: 'prod-2',
          variantId: null,
          quantity: 10,
        }),
      ).rejects.toThrow(/Insufficient stock/);
    });

    it('should validate cumulative stock when stacking same product+variant', async () => {
      // RED test: verify stock check uses cumulative quantity when item already exists
      const sale = Sale.create({ id: 'sale-cumulative', userId: 'user-1' });

      // Pre-add an item with quantity 3
      sale.addItem({
        id: 'item-existing',
        saleId: 'sale-cumulative',
        productId: 'prod-limited',
        variantId: null,
        productName: 'Limited Stock Product',
        variantName: null,
        quantity: 3,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      saleRepo.findById.mockResolvedValue(sale);

      productsService.getProductInfoForSale.mockResolvedValue({
        productId: 'prod-limited',
        productName: 'Limited Stock Product',
        variantId: null,
        variantName: null,
        unitPriceCents: 5000,
      });

      // Stock is 5, existing quantity is 3, incoming is 3, cumulative would be 6 → should fail
      productsService.checkStockAvailability.mockResolvedValue({
        available: false,
        currentStock: 5,
      });

      await expect(
        service.addItem('sale-cumulative', 'user-1', {
          productId: 'prod-limited',
          variantId: null,
          quantity: 3,
        }),
      ).rejects.toThrow(/Insufficient stock/);

      // Verify checkStockAvailability was called with cumulative quantity 6 (3 existing + 3 incoming)
      expect(productsService.checkStockAvailability).toHaveBeenCalledWith(
        'prod-limited',
        null,
        6, // cumulative quantity
      );
    });

    it('should allow stacking when cumulative stock is sufficient', async () => {
      // TRIANGULATE: verify successful stacking when cumulative quantity fits stock
      const sale = Sale.create({ id: 'sale-stack-ok', userId: 'user-1' });

      // Pre-add an item with quantity 2
      sale.addItem({
        id: 'item-existing-ok',
        saleId: 'sale-stack-ok',
        productId: 'prod-ok',
        variantId: null,
        productName: 'Sufficient Stock Product',
        variantName: null,
        quantity: 2,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      saleRepo.findById.mockResolvedValue(sale);

      productsService.getProductInfoForSale.mockResolvedValue({
        productId: 'prod-ok',
        productName: 'Sufficient Stock Product',
        variantId: null,
        variantName: null,
        unitPriceCents: 5000,
      });

      // Stock is 10, existing is 2, incoming is 3, cumulative is 5 → should succeed
      productsService.checkStockAvailability.mockResolvedValue({
        available: true,
        currentStock: 10,
      });

      const result = await service.addItem('sale-stack-ok', 'user-1', {
        productId: 'prod-ok',
        variantId: null,
        quantity: 3,
      });

      // Should have 1 item with stacked quantity 5
      expect(result.items).toHaveLength(1);
      expect(result.items[0].quantity).toBe(5);

      // Verify checkStockAvailability was called with cumulative quantity 5
      expect(productsService.checkStockAvailability).toHaveBeenCalledWith(
        'prod-ok',
        null,
        5,
      );
    });

    it('should not check cumulative stock for different product+variant combinations', async () => {
      // TRIANGULATE: verify non-stacking items use only incoming quantity
      const sale = Sale.create({ id: 'sale-different', userId: 'user-1' });

      // Pre-add a variant "Red"
      sale.addItem({
        id: 'item-red',
        saleId: 'sale-different',
        productId: 'prod-x',
        variantId: 'var-red',
        productName: 'Product X',
        variantName: 'Red',
        quantity: 5,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      saleRepo.findById.mockResolvedValue(sale);

      productsService.getProductInfoForSale.mockResolvedValue({
        productId: 'prod-x',
        productName: 'Product X',
        variantId: 'var-blue',
        variantName: 'Blue',
        unitPriceCents: 5000,
      });

      // Adding variant "Blue" should NOT include "Red" quantity in stock check
      productsService.checkStockAvailability.mockResolvedValue({
        available: true,
        currentStock: 10,
      });

      await service.addItem('sale-different', 'user-1', {
        productId: 'prod-x',
        variantId: 'var-blue',
        quantity: 3,
      });

      // Should check only incoming quantity 3, not cumulative
      expect(productsService.checkStockAvailability).toHaveBeenCalledWith(
        'prod-x',
        'var-blue',
        3, // NOT 8 (5 + 3)
      );
    });
  });

  describe('updateItemQuantity', () => {
    it('should update item quantity and emit event', async () => {
      const sale = Sale.create({ id: 'sale-4', userId: 'user-1' });
      sale.addItem({
        id: 'item-1',
        saleId: 'sale-4',
        productId: 'prod-1',
        variantId: null,
        productName: 'Item',
        variantName: null,
        quantity: 5,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });

      saleRepo.findById.mockResolvedValue(sale);
      productsService.checkStockAvailability.mockResolvedValue({
        available: true,
        currentStock: 100,
      });

      const result = await service.updateItemQuantity(
        'sale-4',
        'user-1',
        'item-1',
        { quantity: 10 },
      );

      expect(result.items[0].quantity).toBe(10);
      expect(saleRepo.save).toHaveBeenCalledWith(expect.any(Sale));
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'sale.item.quantity.changed',
        expect.objectContaining({
          saleId: 'sale-4',
          itemId: 'item-1',
          previousQuantity: 5,
          newQuantity: 10,
        }),
      );
    });

    it('should reject when sale does not exist', async () => {
      saleRepo.findById.mockResolvedValue(null);

      await expect(
        service.updateItemQuantity('nonexistent', 'user-1', 'item-1', {
          quantity: 5,
        }),
      ).rejects.toThrow(EntityNotFoundError);
    });

    it('should reject when user does not own the sale', async () => {
      const sale = Sale.create({ id: 'sale-5', userId: 'user-1' });
      saleRepo.findById.mockResolvedValue(sale);

      await expect(
        service.updateItemQuantity('sale-5', 'user-2', 'item-1', {
          quantity: 5,
        }),
      ).rejects.toThrow(BusinessRuleViolationError);
    });

    it('should reject when insufficient stock for new quantity', async () => {
      const sale = Sale.create({ id: 'sale-6', userId: 'user-1' });
      sale.addItem({
        id: 'item-2',
        saleId: 'sale-6',
        productId: 'prod-3',
        variantId: null,
        productName: 'Limited',
        variantName: null,
        quantity: 2,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });

      saleRepo.findById.mockResolvedValue(sale);
      productsService.checkStockAvailability.mockResolvedValue({
        available: false,
        currentStock: 5,
      });

      await expect(
        service.updateItemQuantity('sale-6', 'user-1', 'item-2', {
          quantity: 10,
        }),
      ).rejects.toThrow(BusinessRuleViolationError);
    });
  });

  describe('clearItems', () => {
    it('should clear all items and emit event', async () => {
      const sale = Sale.create({ id: 'sale-7', userId: 'user-1' });
      sale.addItem({
        id: 'item-3',
        saleId: 'sale-7',
        productId: 'prod-1',
        variantId: null,
        productName: 'Item 1',
        variantName: null,
        quantity: 1,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });
      sale.addItem({
        id: 'item-4',
        saleId: 'sale-7',
        productId: 'prod-2',
        variantId: null,
        productName: 'Item 2',
        variantName: null,
        quantity: 2,
        unitPriceCents: 2000,
        unitPriceCurrency: 'MXN',
      });

      saleRepo.findById.mockResolvedValue(sale);

      const result = await service.clearItems('sale-7', 'user-1');

      expect(result.items).toHaveLength(0);
      expect(saleRepo.save).toHaveBeenCalledWith(expect.any(Sale));
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'sale.cleared',
        expect.objectContaining({
          saleId: 'sale-7',
          clearedItemCount: 2,
        }),
      );
    });

    it('should be idempotent when already empty', async () => {
      const sale = Sale.create({ id: 'sale-8', userId: 'user-1' });
      saleRepo.findById.mockResolvedValue(sale);

      const result = await service.clearItems('sale-8', 'user-1');

      expect(result.items).toHaveLength(0);
      expect(saleRepo.save).toHaveBeenCalledWith(expect.any(Sale));
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'sale.cleared',
        expect.objectContaining({
          clearedItemCount: 0,
        }),
      );
    });
  });

  describe('removeItem', () => {
    it('should remove item, persist, emit event, and return updated sale response', async () => {
      const sale = Sale.create({ id: 'sale-remove-1', userId: 'user-1' });
      sale.addItem({
        id: 'item-keep',
        saleId: 'sale-remove-1',
        productId: 'prod-1',
        variantId: null,
        productName: 'Keep',
        variantName: null,
        quantity: 1,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });
      sale.addItem({
        id: 'item-remove',
        saleId: 'sale-remove-1',
        productId: 'prod-2',
        variantId: null,
        productName: 'Remove',
        variantName: null,
        quantity: 2,
        unitPriceCents: 2000,
        unitPriceCurrency: 'MXN',
      });
      saleRepo.findById.mockResolvedValue(sale);

      const result = await service.removeItem(
        'sale-remove-1',
        'user-1',
        'item-remove',
      );

      expect(result.id).toBe('sale-remove-1');
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe('item-keep');
      expect(saleRepo.save).toHaveBeenCalledWith(expect.any(Sale));
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'sale.item.removed',
        expect.objectContaining({
          saleId: 'sale-remove-1',
          itemId: 'item-remove',
          actorId: 'user-1',
        }),
      );
    });

    it('should throw SALE_NOT_FOUND when sale does not exist', async () => {
      saleRepo.findById.mockResolvedValue(null);

      await expect(
        service.removeItem('sale-remove-404', 'user-1', 'item-remove'),
      ).rejects.toThrow(
        new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND'),
      );
    });

    it('should throw SALE_NOT_DRAFT when sale status is not DRAFT', async () => {
      const sale = Sale.fromPersistence({
        id: 'sale-remove-not-draft',
        userId: 'user-1',
        status: 'COMPLETED' as any,
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      saleRepo.findById.mockResolvedValue(sale);

      await expect(
        service.removeItem('sale-remove-not-draft', 'user-1', 'item-remove'),
      ).rejects.toThrow(
        new BusinessRuleViolationError('SALE_NOT_DRAFT', 'SALE_NOT_DRAFT'),
      );
    });

    it('should throw SALE_UPDATE_FORBIDDEN when actor is not owner', async () => {
      const sale = Sale.create({
        id: 'sale-remove-forbidden',
        userId: 'owner-1',
      });
      saleRepo.findById.mockResolvedValue(sale);

      await expect(
        service.removeItem('sale-remove-forbidden', 'user-2', 'item-remove'),
      ).rejects.toThrow(
        new BusinessRuleViolationError(
          'SALE_UPDATE_FORBIDDEN',
          'SALE_UPDATE_FORBIDDEN',
        ),
      );
    });

    it('should throw SALE_ITEM_NOT_FOUND when item is not in sale', async () => {
      const sale = Sale.create({ id: 'sale-remove-no-item', userId: 'user-1' });
      sale.addItem({
        id: 'item-existing',
        saleId: 'sale-remove-no-item',
        productId: 'prod-1',
        variantId: null,
        productName: 'Existing',
        variantName: null,
        quantity: 1,
        unitPriceCents: 500,
        unitPriceCurrency: 'MXN',
      });
      saleRepo.findById.mockResolvedValue(sale);

      await expect(
        service.removeItem('sale-remove-no-item', 'user-1', 'item-missing'),
      ).rejects.toThrow(
        new BusinessRuleViolationError(
          'SALE_ITEM_NOT_FOUND',
          'SALE_ITEM_NOT_FOUND',
        ),
      );
    });
  });

  describe('deleteDraft', () => {
    it('should delete draft and emit event', async () => {
      const sale = Sale.create({ id: 'sale-9', userId: 'user-1' });
      saleRepo.findById.mockResolvedValue(sale);

      await service.deleteDraft('sale-9', 'user-1');

      expect(saleRepo.delete).toHaveBeenCalledWith('sale-9');
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'sale.draft.deleted',
        expect.objectContaining({
          saleId: 'sale-9',
          userId: 'user-1',
        }),
      );
    });

    it('should reject when sale does not exist', async () => {
      saleRepo.findById.mockResolvedValue(null);

      await expect(
        service.deleteDraft('nonexistent', 'user-1'),
      ).rejects.toThrow(EntityNotFoundError);
    });

    it('should reject when user does not own the sale', async () => {
      const sale = Sale.create({ id: 'sale-10', userId: 'user-1' });
      saleRepo.findById.mockResolvedValue(sale);

      await expect(service.deleteDraft('sale-10', 'user-2')).rejects.toThrow(
        BusinessRuleViolationError,
      );
    });
  });

  describe('getUserDrafts', () => {
    it('should return all drafts for a user', async () => {
      const drafts = [
        Sale.create({ id: 'sale-11', userId: 'user-1' }),
        Sale.create({ id: 'sale-12', userId: 'user-1' }),
      ];

      saleRepo.findDraftsByUserId.mockResolvedValue(drafts);

      const result = await service.getUserDrafts('user-1');

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('sale-11');
      expect(result[1].id).toBe('sale-12');
    });

    it('should return empty array when no drafts exist', async () => {
      saleRepo.findDraftsByUserId.mockResolvedValue([]);

      const result = await service.getUserDrafts('user-2');

      expect(result).toHaveLength(0);
    });

    // S15: Create Unlimited Drafts per User
    it('should allow a user to create 6+ drafts in sequence (unlimited)', async () => {
      const userId = 'user-unlimited';
      const createdDraftIds: string[] = [];

      // Simulate creating 6 drafts in sequence
      for (let i = 1; i <= 6; i++) {
        const draft = await service.openDraft(userId);
        createdDraftIds.push(draft.id);
        expect(draft.userId).toBe(userId);
        expect(draft.status).toBe('DRAFT');
      }

      // Mock getUserDrafts to return all 6 created drafts
      const allDraftsFromRepo = createdDraftIds.map((id) =>
        Sale.create({ id, userId }),
      );
      saleRepo.findDraftsByUserId.mockResolvedValue(allDraftsFromRepo);

      const allDrafts = await service.getUserDrafts(userId);

      // ASSERT: All 6 drafts were created and persisted
      expect(allDrafts).toHaveLength(6);
      expect(allDrafts.every((d) => d.userId === userId)).toBe(true);
      expect(allDrafts.every((d) => d.status === 'DRAFT')).toBe(true);

      // Verify no draft limit was enforced (service never rejected)
      expect(saleRepo.save).toHaveBeenCalledTimes(6);
    });
  });

  describe('searchPosCatalog', () => {
    it('should delegate to ProductsService.searchForPOS', async () => {
      // Arrange
      const mockCatalogResponse = {
        items: [
          {
            id: 'prod-1',
            name: 'Aspirina',
            sku: 'ASP-500',
            barcode: '7501234567890',
            unit: 'PIEZA',
            hasVariants: false,
            useStock: true,
            category: { id: 'cat-1', name: 'Medicamentos' },
            brand: { id: 'brand-1', name: 'Bayer' },
            mainImage: 'https://example.com/asp.jpg',
            images: ['https://example.com/asp.jpg'],
            price: {
              priceCents: 5000,
              priceDecimal: 50,
              priceListName: 'PUBLICO',
            },
            stock: { quantity: 120, minQuantity: 10 },
            variants: [],
          },
        ],
        total: 1,
        limit: 25,
        offset: 0,
      };

      productsService.searchForPOS = jest
        .fn()
        .mockResolvedValue(mockCatalogResponse);

      const dto = { q: 'Aspirina', limit: 25, offset: 0 };

      // Act
      const result = await service.searchPosCatalog(dto);

      // Assert
      expect(result).toEqual(mockCatalogResponse);
      expect(productsService.searchForPOS).toHaveBeenCalledWith(dto);
    });
  });

  describe('getProductDetail', () => {
    it('should delegate to ProductsService.findOneForPOS and return result', async () => {
      const mockProduct = {
        id: 'prod-1',
        name: 'Alimento',
        description: 'Premium',
        enabledForPos: true,
      };
      productsService.findOneForPOS = jest.fn().mockResolvedValue(mockProduct);

      const result = await service.getProductDetail('prod-1');

      expect(result).toEqual(mockProduct);
      expect(productsService.findOneForPOS).toHaveBeenCalledWith('prod-1');
    });

    it('should throw EntityNotFoundError when product not found', async () => {
      productsService.findOneForPOS = jest.fn().mockResolvedValue(null);

      await expect(service.getProductDetail('missing-id')).rejects.toThrow(
        /Product.*missing-id.*not found/,
      );
    });
  });

  describe('listSales', () => {
    it('returns paginated rows and base counts', async () => {
      saleRepo.findManyConfirmed.mockResolvedValue([
        {
          id: 'sale-1',
          folio: 'V-0001',
          status: 'CONFIRMED',
          paymentStatus: 'PAID',
          deliveryStatus: 'DELIVERED',
          totalCents: 1500,
          debtCents: 0,
          confirmedAt: new Date('2026-05-08T10:00:00.000Z'),
          customer: { id: 'c1', name: 'Ana' },
          cashier: { id: 'u1', name: 'Cajero 1' },
          seller: null,
          paymentMethods: ['CASH', 'CARD_DEBIT'],
        },
      ] as any);
      saleRepo.countConfirmed.mockResolvedValue(7);
      saleRepo.groupByPaymentStatusConfirmed.mockResolvedValue([
        { paymentStatus: 'PAID', _count: { _all: 4 } },
        { paymentStatus: 'PARTIAL', _count: { _all: 2 } },
        { paymentStatus: 'CREDIT', _count: { _all: 1 } },
      ] as any);
      saleRepo.countNotDeliveredConfirmed.mockResolvedValue(3);

      const result = await service.listSales({
        page: 2,
        limit: 1,
        paymentStatus: 'PAID',
      } as any);

      expect(result.data).toHaveLength(1);
      expect(result.pagination).toEqual({
        page: 2,
        limit: 1,
        total: 7,
        totalPages: 7,
      });
      expect(result.counts).toEqual({
        all: 7,
        pendingPayments: 3,
        notDelivered: 3,
      });
      expect(saleRepo.findManyConfirmed).toHaveBeenCalledWith(
        expect.objectContaining({ paymentStatus: 'PAID', page: 2, limit: 1 }),
      );
      expect(saleRepo.countConfirmed).toHaveBeenCalledWith(
        expect.objectContaining({}),
      );
      expect(saleRepo.groupByPaymentStatusConfirmed).toHaveBeenCalledWith(
        expect.objectContaining({}),
      );
      expect(saleRepo.countNotDeliveredConfirmed).toHaveBeenCalledWith(
        expect.objectContaining({}),
      );
    });

    it('keeps counts independent from tab filters', async () => {
      saleRepo.findManyConfirmed.mockResolvedValue([] as any);
      saleRepo.countConfirmed.mockResolvedValue(3);
      saleRepo.groupByPaymentStatusConfirmed.mockResolvedValue([
        { paymentStatus: 'PAID', _count: { _all: 1 } },
        { paymentStatus: 'PARTIAL', _count: { _all: 2 } },
      ] as any);
      saleRepo.countNotDeliveredConfirmed.mockResolvedValue(1);

      await service.listSales({
        paymentStatus: 'PAID',
        deliveryStatus: 'DELIVERED',
      } as any);

      expect(saleRepo.findManyConfirmed).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentStatus: 'PAID',
          deliveryStatus: 'DELIVERED',
        }),
      );
      expect(saleRepo.countConfirmed).toHaveBeenCalledWith(
        expect.not.objectContaining({
          paymentStatus: expect.anything(),
          deliveryStatus: expect.anything(),
        }),
      );
      expect(saleRepo.groupByPaymentStatusConfirmed).toHaveBeenCalledWith(
        expect.not.objectContaining({
          paymentStatus: expect.anything(),
          deliveryStatus: expect.anything(),
        }),
      );
      expect(saleRepo.countNotDeliveredConfirmed).toHaveBeenCalledWith(
        expect.not.objectContaining({
          paymentStatus: expect.anything(),
          deliveryStatus: expect.anything(),
        }),
      );
    });
  });

  describe('getSaleDetail', () => {
    it('interleaves COMMENT events in timeline order [REGISTERED, PAYMENT, COMMENT, DELIVERED]', async () => {
      saleRepo.findOneWithRelations = jest.fn().mockResolvedValue({
        id: 'b5e2b8fd-bdfd-471f-b687-ec340d578885',
        folio: 'V-0042',
        status: 'CONFIRMED',
        channel: 'POS',
        register: 'Principal',
        confirmedAt: new Date('2026-05-08T11:00:00.000Z'),
        createdAt: new Date('2026-05-08T10:00:00.000Z'),
        subtotalCents: 2000,
        discountCents: 200,
        totalCents: 1800,
        paidCents: 1800,
        debtCents: 0,
        changeDueCents: 0,
        paymentStatus: 'PAID',
        deliveryStatus: 'DELIVERED',
        customer: { id: 'c1', name: 'Ana' },
        cashier: { id: 'u1', name: 'Caja 1' },
        seller: null,
        items: [],
        payments: [
          {
            method: 'CASH',
            amountCents: 1000,
            tenderedCents: 1000,
            changeCents: 0,
            reference: 'CASH-1',
            paidAt: new Date('2026-05-08T10:20:00.000Z'),
            createdAt: new Date('2026-05-08T10:20:00.000Z'),
            userId: null,
            user: null,
          },
        ],
      } as any);
      saleCommentRepo.findActiveBySale.mockResolvedValue([
        {
          id: 'comment-1',
          saleId: 'b5e2b8fd-bdfd-471f-b687-ec340d578885',
          body: 'Cliente pidió entrega en puerta lateral',
          createdAt: new Date('2026-05-08T10:40:00.000Z'),
          author: { id: 'u2', name: 'Supervisor 1' },
        },
      ]);

      const result = await service.getSaleDetail(
        'b5e2b8fd-bdfd-471f-b687-ec340d578885',
      );

      expect(result.timeline.map((event) => event.type)).toEqual([
        'SALE_REGISTERED',
        'PAYMENT_RECEIVED',
        'COMMENT',
        'PRODUCTS_DELIVERED',
      ]);
    });

    it('only includes comments returned by findActiveBySale (which excludes soft-deleted at repo layer)', async () => {
      saleRepo.findOneWithRelations = jest.fn().mockResolvedValue({
        id: 'b5e2b8fd-bdfd-471f-b687-ec340d578885',
        folio: 'V-0042',
        status: 'CONFIRMED',
        channel: 'POS',
        register: 'Principal',
        confirmedAt: new Date('2026-05-08T11:00:00.000Z'),
        createdAt: new Date('2026-05-08T10:00:00.000Z'),
        subtotalCents: 2000,
        discountCents: 200,
        totalCents: 1800,
        paidCents: 1800,
        debtCents: 0,
        changeDueCents: 0,
        paymentStatus: 'PAID',
        deliveryStatus: 'DELIVERED',
        customer: { id: 'c1', name: 'Ana' },
        cashier: { id: 'u1', name: 'Caja 1' },
        seller: null,
        items: [],
        payments: [],
      } as any);
      saleCommentRepo.findActiveBySale.mockResolvedValue([
        {
          id: 'comment-2',
          saleId: 'b5e2b8fd-bdfd-471f-b687-ec340d578885',
          body: 'Entregado completo',
          createdAt: new Date('2026-05-08T10:50:00.000Z'),
          author: { id: 'u3', name: 'Caja 2' },
        },
      ]);

      const result = await service.getSaleDetail(
        'b5e2b8fd-bdfd-471f-b687-ec340d578885',
      );

      expect(result.timeline.some((event) => event.type === 'COMMENT')).toBe(
        true,
      );
    });

    it('maps repository detail shape with per-payment timeline and references', async () => {
      saleRepo.findOneWithRelations = jest.fn().mockResolvedValue({
        id: 'b5e2b8fd-bdfd-471f-b687-ec340d578885',
        folio: 'V-0042',
        status: 'CONFIRMED',
        channel: 'POS',
        register: 'Principal',
        confirmedAt: new Date('2026-05-08T11:00:00.000Z'),
        createdAt: new Date('2026-05-08T10:00:00.000Z'),
        subtotalCents: 2000,
        discountCents: 200,
        totalCents: 1800,
        paidCents: 1800,
        debtCents: 0,
        changeDueCents: 0,
        paymentStatus: 'PAID',
        deliveryStatus: 'DELIVERED',
        customer: { id: 'c1', name: 'Ana' },
        cashier: { id: 'u1', name: 'Caja 1' },
        seller: null,
        items: [
          {
            productName: 'Prod 1',
            variantName: null,
            imageUrl: 'https://cdn/img.jpg',
            unitPriceCents: 900,
            quantity: 2,
            discountCents: 0,
            subtotalCents: 1800,
          },
        ],
        payments: [
          {
            method: 'CASH',
            amountCents: 1000,
            tenderedCents: 1000,
            changeCents: 0,
            reference: 'CASH-1',
            paidAt: new Date('2026-05-08T10:20:00.000Z'),
            createdAt: new Date('2026-05-08T10:20:00.000Z'),
            userId: null,
            user: null,
          },
          {
            method: 'TRANSFER',
            amountCents: 800,
            tenderedCents: 800,
            changeCents: 0,
            reference: 'TRF-2',
            paidAt: new Date('2026-05-08T10:30:00.000Z'),
            createdAt: new Date('2026-05-08T10:30:00.000Z'),
            userId: null,
            user: null,
          },
        ],
      } as any);

      const result = await service.getSaleDetail(
        'b5e2b8fd-bdfd-471f-b687-ec340d578885',
      );

      expect(result.id).toBe('b5e2b8fd-bdfd-471f-b687-ec340d578885');
      expect(result.timeline).toHaveLength(4);
      expect(result.timeline[1]).toEqual(
        expect.objectContaining({
          type: 'PAYMENT_RECEIVED',
          at: '2026-05-08T10:20:00.000Z',
          method: 'CASH',
          amountCents: 1000,
          reference: 'CASH-1',
          actor: { id: 'u1', name: 'Caja 1' },
          register: 'Principal',
        }),
      );
      expect(result.timeline[2]).toEqual(
        expect.objectContaining({
          type: 'PAYMENT_RECEIVED',
          at: '2026-05-08T10:30:00.000Z',
          method: 'TRANSFER',
          amountCents: 800,
          reference: 'TRF-2',
          actor: { id: 'u1', name: 'Caja 1' },
          register: 'Principal',
        }),
      );
      expect(result.payments[0].paidAt).toBe('2026-05-08T10:20:00.000Z');
      expect(result.payments[0].reference).toBe('CASH-1');
      expect(result.payments[1].reference).toBe('TRF-2');
    });

    it('throws 400 for invalid UUID input', async () => {
      await expect(service.getSaleDetail('invalid-id')).rejects.toThrow(
        'Validation failed (uuid is expected)',
      );
    });

    it('throws 404 for missing or cross-tenant sale', async () => {
      saleRepo.findOneWithRelations = jest.fn().mockResolvedValue(null);

      await expect(
        service.getSaleDetail('b5e2b8fd-bdfd-471f-b687-ec340d578885'),
      ).rejects.toThrow('Sale not found');
    });
  });

  describe('price override use cases', () => {
    it('getAvailablePrices should return mapped prices with isCurrent', async () => {
      const sale = Sale.create({ id: 'sale-av', userId: 'user-1' });
      sale.addItem({
        id: 'item-av',
        saleId: 'sale-av',
        productId: 'prod-1',
        variantId: null,
        productName: 'P',
        variantName: null,
        quantity: 2,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });
      saleRepo.findById.mockResolvedValue(sale);
      productsService.getApplicablePrices.mockResolvedValue([
        { priceListId: 'pl-1', priceListName: 'PUBLICO', priceCents: 1000 },
      ]);

      const result = await service.getAvailablePrices(
        'sale-av',
        'item-av',
        'user-1',
      );
      expect(result.prices[0].isCurrent).toBe(true);
    });

    it('getAvailablePrices should match current by appliedPriceListId first', async () => {
      const sale = Sale.create({ id: 'sale-av2', userId: 'user-1' });
      sale.addItem({
        id: 'item-av2',
        saleId: 'sale-av2',
        productId: 'prod-1',
        variantId: null,
        productName: 'P',
        variantName: null,
        quantity: 2,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });
      sale.overrideItemPrice('item-av2', {
        priceCents: 950,
        priceSource: 'price_list',
        appliedPriceListId: 'pl-2',
        customPriceCents: null,
      });

      saleRepo.findById.mockResolvedValue(sale);
      productsService.getApplicablePrices.mockResolvedValue([
        { priceListId: 'pl-1', priceListName: 'PUBLICO', priceCents: 950 },
        { priceListId: 'pl-2', priceListName: 'MAYOREO', priceCents: 950 },
      ]);

      const result = await service.getAvailablePrices(
        'sale-av2',
        'item-av2',
        'user-1',
      );
      expect(
        result.prices.find((p) => p.priceListId === 'pl-1')?.isCurrent,
      ).toBe(false);
      expect(
        result.prices.find((p) => p.priceListId === 'pl-2')?.isCurrent,
      ).toBe(true);
    });

    it('getAvailablePrices should fallback to unitPrice match when appliedPriceListId is null', async () => {
      const sale = Sale.create({ id: 'sale-av3', userId: 'user-1' });
      sale.addItem({
        id: 'item-av3',
        saleId: 'sale-av3',
        productId: 'prod-1',
        variantId: null,
        productName: 'P',
        variantName: null,
        quantity: 2,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });

      saleRepo.findById.mockResolvedValue(sale);
      productsService.getApplicablePrices.mockResolvedValue([
        { priceListId: 'pl-1', priceListName: 'PUBLICO', priceCents: 1000 },
        { priceListId: 'pl-2', priceListName: 'MAYOREO', priceCents: 900 },
      ]);

      const result = await service.getAvailablePrices(
        'sale-av3',
        'item-av3',
        'user-1',
      );
      expect(
        result.prices.find((p) => p.priceListId === 'pl-1')?.isCurrent,
      ).toBe(true);
      expect(
        result.prices.find((p) => p.priceListId === 'pl-2')?.isCurrent,
      ).toBe(false);
    });

    it('overrideItemPrice should emit one audit event', async () => {
      const sale = Sale.create({ id: 'sale-ov', userId: 'user-1' });
      sale.addItem({
        id: 'item-ov',
        saleId: 'sale-ov',
        productId: 'prod-1',
        variantId: null,
        productName: 'P',
        variantName: null,
        quantity: 2,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });
      saleRepo.findById.mockResolvedValue(sale);
      saleRepo.save.mockResolvedValue(sale);
      productsService.resolveListPrice.mockResolvedValue(900);

      await service.overrideItemPrice(
        'sale-ov',
        'item-ov',
        { priceListId: 'pl-1' },
        'user-1',
      );

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'sale.item.price.overridden',
        expect.any(Object),
      );
    });
  });

  // ============================================================================
  // Work Unit 4 — Wire recomputePromotions into draft mutations (4.1, 4.2)
  // ============================================================================
  describe('Work Unit 4 — recomputePromotions wiring (4.1, 4.2)', () => {
    /**
     * Build a fresh draft sale with a single item already added in-memory
     * (skipping the recompute loop the service runs). Returns the same sale
     * the service will see from `saleRepo.findById`.
     */
    function buildDraftWithItem(
      id: string,
      itemId: string,
      productId = 'prod-1',
      unitPriceCents = 1000,
      quantity = 2,
    ) {
      const sale = Sale.create({ id, userId: 'user-1' });
      sale.addItem({
        id: itemId,
        saleId: id,
        productId,
        variantId: null,
        productName: 'P',
        variantName: null,
        quantity,
        unitPriceCents,
        unitPriceCurrency: 'MXN',
      });
      return sale;
    }

    it('addItem calls the engine and applies an AUTOMATIC PRODUCT_DISCOUNT to the matching line (4.1)', async () => {
      const saleId = 'sale-rec-add';
      saleRepo.findById.mockResolvedValue(
        Sale.create({ id: saleId, userId: 'user-1' }),
      );
      productsService.getProductInfoForSale.mockResolvedValue({
        productId: 'prod-1',
        productName: 'P',
        variantId: null,
        variantName: null,
        unitPriceCents: 1000,
      });
      productsService.checkStockAvailability.mockResolvedValue({
        available: true,
        currentStock: 100,
      });
      // Engine returns the AUTO promo for whatever line is passed in.
      posEvaluateUseCase.evaluate.mockImplementation((input) => {
        const line = input.lines[0];
        return Promise.resolve({
          lines: line
            ? [
                {
                  itemId: line.itemId,
                  promotionId: 'promo-auto-1',
                  discountType: 'percentage',
                  discountValue: 10,
                  discountTitle: '10% off',
                },
              ]
            : [],
          order: null,
          availableManualPromotions: [],
        });
      });

      await service.addItem(saleId, 'user-1', {
        productId: 'prod-1',
        variantId: null,
        quantity: 2,
      });

      // Capture the actual itemId from the saved sale (addItem uses randomUUID).
      const savedSale = saleRepo.save.mock.calls.at(-1)?.[0] as Sale;
      const actualItemId = savedSale.items[0].id;

      // The engine WAS called after the in-memory mutation.
      expect(posEvaluateUseCase.evaluate).toHaveBeenCalledTimes(1);

      // The recompute input captured the new line with the pre-promo base
      // (`effectiveUnitPriceCents` = unitPriceCents when no prior discount).
      const input = posEvaluateUseCase.evaluate.mock.calls[0][0];
      expect(input.lines).toHaveLength(1);
      expect(input.lines[0]).toMatchObject({
        itemId: actualItemId,
        productId: 'prod-1',
        variantId: null,
        quantity: 2,
        effectiveUnitPriceCents: 1000,
        appliedPriceListId: null,
        appliedGlobalPriceListId: null,
        hasManualDiscount: false,
      });

      // `saleRepo.save` ran AFTER recompute — the saved sale carries the
      // promo-sourced discount (recompute mutates the in-memory aggregate).
      expect(savedSale.items[0].promotionId).toBe('promo-auto-1');
      expect(savedSale.items[0].discountType).toBe('percentage');
      expect(savedSale.items[0].discountValue).toBe(10);
      // 10% of 1000 = 100 → unitPriceCents drops from 1000 to 900.
      expect(savedSale.items[0].unitPriceCents).toBe(900);
    });

    it('addItem recompute is idempotent: running recompute twice yields the same discount (no compounding) (4.1)', async () => {
      const saleId = 'sale-rec-idem';
      saleRepo.findById.mockResolvedValue(
        Sale.create({ id: saleId, userId: 'user-1' }),
      );
      productsService.getProductInfoForSale.mockResolvedValue({
        productId: 'prod-1',
        productName: 'P',
        variantId: null,
        variantName: null,
        unitPriceCents: 1000,
      });
      productsService.checkStockAvailability.mockResolvedValue({
        available: true,
        currentStock: 100,
      });
      // Engine returns 10% off for whatever line is passed in.
      posEvaluateUseCase.evaluate.mockImplementation((input) => {
        const line = input.lines[0];
        return Promise.resolve({
          lines: line
            ? [
                {
                  itemId: line.itemId,
                  promotionId: 'promo-auto-1',
                  discountType: 'percentage',
                  discountValue: 10,
                  discountTitle: '10% off',
                },
              ]
            : [],
          order: null,
          availableManualPromotions: [],
        });
      });

      await service.addItem(saleId, 'user-1', {
        productId: 'prod-1',
        variantId: null,
        quantity: 1,
      });
      const afterFirst = (
        saleRepo.save.mock.calls.at(-1)?.[0] as Sale
      ).items[0];
      const actualItemId = afterFirst.id;
      expect(afterFirst.unitPriceCents).toBe(900);
      expect(afterFirst.prePriceCentsBeforeDiscount).toBe(1000);

      // Second mutation (updateItemQuantity, qty 1 -> 2): recompute runs again.
      // The mock returns the SAME promo again — but the discount must still
      // compute against the ORIGINAL baseline (1000), not the new 900.
      saleRepo.findById.mockResolvedValue(
        Sale.fromPersistence({
          id: saleId,
          userId: 'user-1',
          status: 'DRAFT',
          createdAt: new Date(),
          updatedAt: new Date(),
          items: [
            {
              id: actualItemId,
              saleId,
              productId: 'prod-1',
              variantId: null,
              productName: 'P',
              variantName: null,
              quantity: 1,
              unitPriceCents: 900,
              unitPriceCurrency: 'MXN',
              prePriceCentsBeforeDiscount: 1000,
              discountType: 'percentage',
              discountValue: 10,
              discountAmountCents: 100,
              discountTitle: '10% off',
              promotionId: 'promo-auto-1',
            },
          ],
        }),
      );
      productsService.checkStockAvailability.mockResolvedValue({
        available: true,
        currentStock: 100,
      });
      await service.updateItemQuantity(saleId, 'user-1', actualItemId, {
        quantity: 2,
      });

      const secondInput = posEvaluateUseCase.evaluate.mock.calls.at(-1)?.[0];
      // effectiveUnitPriceCents must be the ORIGINAL baseline (1000),
      // NOT the discounted 900.
      expect(secondInput.lines[0].effectiveUnitPriceCents).toBe(1000);
      expect(secondInput.lines[0].quantity).toBe(2);

      const afterSecond = (
        saleRepo.save.mock.calls.at(-1)?.[0] as Sale
      ).items[0];
      // Discount still 10% of 1000 = 100 → unitPriceCents stays at 900.
      expect(afterSecond.unitPriceCents).toBe(900);
      expect(afterSecond.discountAmountCents).toBe(100);
      expect(afterSecond.promotionId).toBe('promo-auto-1');
    });

    it('updateItemQuantity triggers recompute (engine called, prior auto-promo re-applied) (4.2)', async () => {
      const saleId = 'sale-rec-qty';
      const itemId = 'item-rec-qty';
      const sale = Sale.fromPersistence({
        id: saleId,
        userId: 'user-1',
        status: 'DRAFT',
        createdAt: new Date(),
        updatedAt: new Date(),
        items: [
          {
            id: itemId,
            saleId,
            productId: 'prod-1',
            variantId: null,
            productName: 'P',
            variantName: null,
            quantity: 1,
            unitPriceCents: 1000,
            unitPriceCurrency: 'MXN',
          },
        ],
      });
      saleRepo.findById.mockResolvedValue(sale);
      productsService.checkStockAvailability.mockResolvedValue({
        available: true,
        currentStock: 100,
      });
      posEvaluateUseCase.evaluate.mockResolvedValue({
        lines: [
          {
            itemId,
            promotionId: 'promo-auto-1',
            discountType: 'percentage',
            discountValue: 10,
            discountTitle: '10% off',
          },
        ],
        order: null,
        availableManualPromotions: [],
      });

      await service.updateItemQuantity(saleId, 'user-1', itemId, {
        quantity: 5,
      });

      expect(posEvaluateUseCase.evaluate).toHaveBeenCalledTimes(1);
      const saved = saleRepo.save.mock.calls.at(-1)?.[0] as Sale;
      expect(saved.items[0].quantity).toBe(5);
      // The promo is re-applied to the new qty.
      expect(saved.items[0].promotionId).toBe('promo-auto-1');
      expect(saved.items[0].discountType).toBe('percentage');
    });

    it('removeItem triggers recompute and clears the auto-promo on the removed item (4.2)', async () => {
      const saleId = 'sale-rec-rm';
      const itemAId = 'item-rec-rm-a';
      const itemBId = 'item-rec-rm-b';
      const sale = Sale.fromPersistence({
        id: saleId,
        userId: 'user-1',
        status: 'DRAFT',
        createdAt: new Date(),
        updatedAt: new Date(),
        items: [
          {
            id: itemAId,
            saleId,
            productId: 'prod-1',
            variantId: null,
            productName: 'A',
            variantName: null,
            quantity: 1,
            unitPriceCents: 1000,
            unitPriceCurrency: 'MXN',
            discountType: 'percentage',
            discountValue: 10,
            discountAmountCents: 100,
            prePriceCentsBeforeDiscount: 1000,
            discountTitle: '10% off',
            promotionId: 'promo-auto-1',
          },
          {
            id: itemBId,
            saleId,
            productId: 'prod-2',
            variantId: null,
            productName: 'B',
            variantName: null,
            quantity: 2,
            unitPriceCents: 2000,
            unitPriceCurrency: 'MXN',
          },
        ],
      });
      saleRepo.findById.mockResolvedValue(sale);
      // After removal, the engine returns nothing for the surviving item B.
      posEvaluateUseCase.evaluate.mockResolvedValue({
        lines: [],
        order: null,
        availableManualPromotions: [],
      });

      const result = await service.removeItem(saleId, 'user-1', itemAId);

      expect(posEvaluateUseCase.evaluate).toHaveBeenCalledTimes(1);
      // The recompute ran with only item B (the removed item was gone).
      const input = posEvaluateUseCase.evaluate.mock.calls[0][0];
      expect(input.lines.map((l: { itemId: string }) => l.itemId)).toEqual([
        itemBId,
      ]);
      // Returned response has only item B, untouched.
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe(itemBId);
      expect(result.items[0].promotionId).toBeNull();
    });

    it('assignCustomer triggers recompute: a SPECIFIC promo auto-applies after the eligible customer is assigned (4.2)', async () => {
      const saleId = 'sale-rec-cust';
      const itemId = 'item-rec-cust';
      const customerId = 'cust-eligible';

      // Sale loaded BEFORE assign: no customer, item at full price.
      const saleBeforeAssign = Sale.fromPersistence({
        id: saleId,
        userId: 'user-1',
        status: 'DRAFT',
        createdAt: new Date(),
        updatedAt: new Date(),
        items: [
          {
            id: itemId,
            saleId,
            productId: 'prod-1',
            variantId: null,
            productName: 'P',
            variantName: null,
            quantity: 1,
            unitPriceCents: 1000,
            unitPriceCurrency: 'MXN',
          },
        ],
      });
      saleRepo.findById.mockResolvedValue(saleBeforeAssign);

      // Customer exists in the tenant prisma (assignCustomer preloads it).
      (tenantPrisma.getClient as jest.Mock).mockReturnValue({
        customer: {
          findUnique: jest.fn().mockResolvedValue({ id: customerId }),
        },
        customerAddress: {
          findUnique: jest.fn(),
        },
      });

      // Engine: customer-scoped promo applies only AFTER assignment.
      // We simulate that by returning the line result conditionally — for
      // this test, we return it once because the engine itself would have
      // been called WITH customerId set after assignment.
      posEvaluateUseCase.evaluate.mockResolvedValue({
        lines: [
          {
            itemId,
            promotionId: 'promo-specific-1',
            discountType: 'percentage',
            discountValue: 15,
            discountTitle: 'VIP 15% off',
          },
        ],
        order: null,
        availableManualPromotions: [],
      });

      // findDraftResponseById reload for the response.
      saleRepo.findDraftResponseById.mockResolvedValue(
        Sale.fromPersistence({
          id: saleId,
          userId: 'user-1',
          status: 'DRAFT',
          createdAt: new Date(),
          updatedAt: new Date(),
          items: [
            {
              id: itemId,
              saleId,
              productId: 'prod-1',
              variantId: null,
              productName: 'P',
              variantName: null,
              quantity: 1,
              unitPriceCents: 850,
              unitPriceCurrency: 'MXN',
              discountType: 'percentage',
              discountValue: 15,
              discountAmountCents: 150,
              prePriceCentsBeforeDiscount: 1000,
              discountTitle: 'VIP 15% off',
              promotionId: 'promo-specific-1',
            },
          ],
        }).toResponse(),
      );

      await service.assignCustomer(saleId, 'user-1', { customerId });

      // The engine was called once, with the assigned customerId.
      expect(posEvaluateUseCase.evaluate).toHaveBeenCalledTimes(1);
      const input = posEvaluateUseCase.evaluate.mock.calls[0][0];
      expect(input.customerId).toBe(customerId);
      // saleRepo.save was called BEFORE the draft response reload.
      expect(saleRepo.save).toHaveBeenCalled();
      // The saved sale carries the SPECIFIC promo applied to the item.
      const saved = saleRepo.save.mock.calls.at(-1)?.[0] as Sale;
      expect(saved.customerId).toBe(customerId);
      expect(saved.items[0].promotionId).toBe('promo-specific-1');
      expect(saved.items[0].discountType).toBe('percentage');
    });

    it('addItem with no matching promos is a safe no-op (engine returns empty, items unchanged) (4.7 boundary)', async () => {
      const saleId = 'sale-rec-noop';
      saleRepo.findById.mockResolvedValue(
        Sale.create({ id: saleId, userId: 'user-1' }),
      );
      productsService.getProductInfoForSale.mockResolvedValue({
        productId: 'prod-1',
        productName: 'P',
        variantId: null,
        variantName: null,
        unitPriceCents: 1000,
      });
      productsService.checkStockAvailability.mockResolvedValue({
        available: true,
        currentStock: 100,
      });
      // Engine default mock already returns empty — explicit anyway for clarity.
      posEvaluateUseCase.evaluate.mockResolvedValue({
        lines: [],
        order: null,
        availableManualPromotions: [],
      });

      const result = await service.addItem(saleId, 'user-1', {
        productId: 'prod-1',
        variantId: null,
        quantity: 1,
      });

      expect(posEvaluateUseCase.evaluate).toHaveBeenCalledTimes(1);
      expect(result.items[0].promotionId).toBeNull();
      expect(result.items[0].discountType).toBeNull();
      expect(result.items[0].unitPriceCents).toBe(1000);
    });

    it('recompute calls ProductsService.resolvePriceListGlobalIds once with the DISTINCT appliedPriceListIds (C1 wiring)', async () => {
      const saleId = 'sale-rec-c1';
      const itemAId = 'item-rec-c1-a';
      const itemBId = 'item-rec-c1-b';
      // Two items, each with a price-list override — two distinct ids.
      const sale = Sale.fromPersistence({
        id: saleId,
        userId: 'user-1',
        status: 'DRAFT',
        createdAt: new Date(),
        updatedAt: new Date(),
        items: [
          {
            id: itemAId,
            saleId,
            productId: 'prod-1',
            variantId: null,
            productName: 'A',
            variantName: null,
            quantity: 1,
            unitPriceCents: 1000,
            unitPriceCurrency: 'MXN',
            appliedPriceListId: 'PL-a',
            priceSource: 'price_list',
          },
          {
            id: itemBId,
            saleId,
            productId: 'prod-2',
            variantId: null,
            productName: 'B',
            variantName: null,
            quantity: 1,
            unitPriceCents: 2000,
            unitPriceCurrency: 'MXN',
            appliedPriceListId: 'PL-b',
            priceSource: 'price_list',
          },
        ],
      });
      saleRepo.findById.mockResolvedValue(sale);
      productsService.checkStockAvailability.mockResolvedValue({
        available: true,
        currentStock: 100,
      });
      productsService.resolvePriceListGlobalIds.mockResolvedValue(
        new Map<string, string>([
          ['PL-a', 'GPL-retail'],
          ['PL-b', 'GPL-mayoreo'],
        ]),
      );

      await service.updateItemQuantity(saleId, 'user-1', itemAId, {
        quantity: 3,
      });

      // Resolver called ONCE (batch), with the DISTINCT ids.
      expect(
        productsService.resolvePriceListGlobalIds,
      ).toHaveBeenCalledTimes(1);
      const ids = (
        productsService.resolvePriceListGlobalIds as jest.Mock
      ).mock.calls[0][0] as string[];
      expect([...ids].sort()).toEqual(['PL-a', 'PL-b']);

      // Engine input carries the resolved global ids per line (C1).
      const input = posEvaluateUseCase.evaluate.mock.calls[0][0];
      const lineA = input.lines.find(
        (l: { itemId: string }) => l.itemId === itemAId,
      );
      const lineB = input.lines.find(
        (l: { itemId: string }) => l.itemId === itemBId,
      );
      expect(lineA.appliedPriceListId).toBe('PL-a');
      expect(lineA.appliedGlobalPriceListId).toBe('GPL-retail');
      expect(lineB.appliedPriceListId).toBe('PL-b');
      expect(lineB.appliedGlobalPriceListId).toBe('GPL-mayoreo');
    });
  });

  // ============================================================================
  // Work Unit 5 — Charge + Override + Inline Totals (5.1, 5.3, 5.4, 5.7)
  //
  // The HIGHEST-RISK slice of the change: any totals-drift between the charge
  // path and the draft preview re-introduces C2. The tests below lock the
  // contract:
  //   5.1 RED — overrideItemPrice re-applies an eligible auto-promo on the new
  //             price (the override wipes any prior discount; recompute must
  //             re-apply auto-promos so promo-on-top-of-price-list still wins).
  //   5.3 RED — chargeDraft triggers a recompute inside its runInTransaction
  //             block so the charged total is authoritative against the
  //             current state (a qty change after the last draft recompute
  //             must be picked up).
  //   5.4 RED (C2) — a draft with an applied ORDER_DISCOUNT must charge
  //             `totalCents = Σ(unitPrice·qty) − orderDiscountCents`; this is
  //             the C2 proof for the charge path (same maths as the draft
  //             preview, single source of truth).
  //   5.7 GREEN (C2) — inline totals reuse `sale.previewTotals()` so the
  //             adapter call receives the order-discount-adjusted numbers;
  //             covered transitively by the 5.4 test (asserting
  //             `persistChargeConfirmation` saw the right `totalCents` /
  //             `discountCents`).
  // ============================================================================
  describe('Work Unit 5 — charge + override + inline totals', () => {
    /**
     * Build a DRAFT sale usable by charge-time tests.
     * Items are persisted at unitPriceCents=1000 qty=2 → subtotal=2000.
     * Caller may overlay an `appliedOrderPromotion` snapshot.
     */
    function buildDraftSaleWithTotals(
      id: string,
      overrides: {
        appliedOrderPromotion?: {
          promotionId: string;
          discountType: 'amount' | 'percentage';
          discountValue: number;
          discountAmountCents: number;
          discountTitle: string;
        } | null;
        unitPriceCents?: number;
        quantity?: number;
        discountAmountCents?: number;
        prePriceCentsBeforeDiscount?: number;
        discountType?: 'amount' | 'percentage' | null;
        discountValue?: number;
      } = {},
    ) {
      const unit = overrides.unitPriceCents ?? 1000;
      const qty = overrides.quantity ?? 2;
      const props: Parameters<typeof Sale.fromPersistence>[0] = {
        id,
        userId: 'user-1',
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
            quantity: qty,
            unitPriceCents: unit,
            unitPriceCurrency: 'MXN',
            ...(overrides.prePriceCentsBeforeDiscount !== undefined
              ? {
                  prePriceCentsBeforeDiscount:
                    overrides.prePriceCentsBeforeDiscount,
                }
              : {}),
            ...(overrides.discountType !== undefined
              ? { discountType: overrides.discountType }
              : {}),
            ...(overrides.discountValue !== undefined
              ? { discountValue: overrides.discountValue }
              : {}),
            ...(overrides.discountAmountCents !== undefined
              ? { discountAmountCents: overrides.discountAmountCents }
              : {}),
          },
        ],
        ...(overrides.appliedOrderPromotion !== undefined
          ? { appliedOrderPromotion: overrides.appliedOrderPromotion }
          : {}),
      };
      return Sale.fromPersistence(props);
    }

    it('5.1 RED — overrideItemPrice re-runs recompute so an eligible auto-promo applies on the NEW price', async () => {
      const saleId = 'sale-u5-override-recompute';
      const itemId = 'item-u5-override-1';
      const sale = Sale.create({ id: saleId, userId: 'user-1' });
      sale.addItem({
        id: itemId,
        saleId,
        productId: 'prod-1',
        variantId: null,
        productName: 'P',
        variantName: null,
        quantity: 1,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });
      saleRepo.findById.mockResolvedValue(sale);
      saleRepo.save.mockResolvedValue(sale);
      // resolveListPrice returns 800 for the PRICE_LIST override.
      productsService.resolveListPrice.mockResolvedValue(800);
      // Engine returns 10% promo on the line → after recompute unitPrice should
      // drop from 800 to 720 (NOT stay at 800 — old behavior was 800 with no
      // recompute).
      posEvaluateUseCase.evaluate.mockImplementation((input) => {
        const line = input.lines[0];
        return Promise.resolve({
          lines: line
            ? [
                {
                  itemId: line.itemId,
                  promotionId: 'promo-auto-override-1',
                  discountType: 'percentage',
                  discountValue: 10,
                  discountTitle: '10% off',
                },
              ]
            : [],
          order: null,
          availableManualPromotions: [],
        });
      });

      await service.overrideItemPrice(
        saleId,
        itemId,
        { priceListId: 'pl-1' },
        'user-1',
      );

      // Recompute WAS called during overrideItemPrice (this is the new wiring).
      expect(posEvaluateUseCase.evaluate).toHaveBeenCalledTimes(1);
      const recomputeInput =
        posEvaluateUseCase.evaluate.mock.calls[0][0];
      // The recompute input carries the NEW unitPriceCents (800) — recompute
      // runs AFTER overridePrice, on the new baseline.
      expect(recomputeInput.lines[0].effectiveUnitPriceCents).toBe(800);

      // The saved sale has the auto promo applied on the NEW price:
      // 10% of 800 = 80 → unitPriceCents = 720.
      const savedSale = saleRepo.save.mock.calls.at(-1)?.[0] as Sale;
      const savedItem = savedSale.items.find((i) => i.id === itemId)!;
      expect(savedItem.promotionId).toBe('promo-auto-override-1');
      expect(savedItem.discountType).toBe('percentage');
      expect(savedItem.discountValue).toBe(10);
      expect(savedItem.prePriceCentsBeforeDiscount).toBe(800);
      expect(savedItem.unitPriceCents).toBe(720);
    });

    it('5.3 RED — chargeDraft triggers a recompute inside the runInTransaction block', async () => {
      const saleId = 'sale-u5-charge-recompute';
      const sale = buildDraftSaleWithTotals(saleId, {
        // Subtotal 2000; no per-line discount; no order promo.
        unitPriceCents: 1000,
        quantity: 2,
      });
      // Freshness loop must succeed against live prices:
      saleRepo.findByIdForUpdate.mockResolvedValue(sale);
      productsService.getProductInfoForSale.mockResolvedValue({
        unitPriceCents: 1000,
      });
      productsService.decrementStockForCharge.mockResolvedValue([]);
      saleRepo.allocateNextFolio.mockResolvedValue('A-2605-000050');
      saleRepo.persistChargeConfirmation.mockResolvedValue([]);

      await service.chargeDraft(
        saleId,
        'user-1',
        { method: 'cash', amountCents: 2000 },
        'idem-u5-charge-recompute',
      );

      // The engine WAS called inside the charge tx — recompute is authoritative.
      expect(posEvaluateUseCase.evaluate).toHaveBeenCalledTimes(1);
      const chargeInput =
        posEvaluateUseCase.evaluate.mock.calls[0][0];
      expect(chargeInput.lines).toHaveLength(1);
      expect(chargeInput.lines[0].itemId).toBe(`${saleId}-item-1`);
    });

    it('5.4 RED (C2) — chargeDraft totalCents reflects the applied ORDER_DISCOUNT via previewTotals (single source of truth)', async () => {
      const saleId = 'sale-u5-c2-order-charge';
      const sale = buildDraftSaleWithTotals(saleId, {
        unitPriceCents: 1000,
        quantity: 2,
        appliedOrderPromotion: {
          promotionId: 'promo-order-c2',
          discountType: 'amount',
          discountValue: 500,
          discountAmountCents: 500,
          discountTitle: '$500 off',
        },
      });
      saleRepo.findByIdForUpdate.mockResolvedValue(sale);
      productsService.getProductInfoForSale.mockResolvedValue({
        unitPriceCents: 1000,
      });
      productsService.decrementStockForCharge.mockResolvedValue([]);
      saleRepo.allocateNextFolio.mockResolvedValue('A-2605-000060');
      saleRepo.persistChargeConfirmation.mockResolvedValue([]);
      // The charge-time recompute must KEEP the applied order promo so
      // previewTotals() reduces the total. This models the realistic flow:
      // the engine returned the same order discount at charge time as it
      // did at the last draft recompute, so the in-memory state survives.
      posEvaluateUseCase.evaluate.mockResolvedValue({
        lines: [],
        order: {
          promotionId: 'promo-order-c2',
          discountType: 'amount',
          discountValue: 500,
          discountTitle: '$500 off',
          discountAmountCents: 500,
        },
        availableManualPromotions: [],
      });

      const result = await service.chargeDraft(
        saleId,
        'user-1',
        { method: 'cash', amountCents: 1500 },
        'idem-u5-c2-order-charge',
      );

      // subtotal=2000, orderDiscount=500 → total=1500, discount=500.
      // This is THE C2 proof: the same previewTotals() helper the draft
      // preview uses is the SOLE source of truth at charge time.
      expect(result.subtotalCents).toBe(2000);
      expect(result.discountCents).toBe(500);
      expect(result.totalCents).toBe(1500);
      expect(result.paidCents).toBe(1500);
      expect(result.paymentStatus).toBe('PAID');

      // The persistChargeConfirmation payload ALSO carried the order-discount-
      // adjusted numbers — this is what gets persisted as the Sale row.
      expect(saleRepo.persistChargeConfirmation).toHaveBeenCalledWith(
        expect.objectContaining({
          saleId,
          subtotalCents: 2000,
          discountCents: 500,
          totalCents: 1500,
          paidCents: 1500,
          debtCents: 0,
          paymentStatus: 'PAID',
          // The applied-order-promo snapshot was forwarded to the repo so
          // it can upsert the sale_promotion_applied row inside the tx.
          appliedOrderPromotion: expect.objectContaining({
            promotionId: 'promo-order-c2',
            discountAmountCents: 500,
          }),
        }),
      );
    });

    it('5.7 GREEN (C2) — chargeDraft inline totals reuse previewTotals when no order discount is applied (no regression)', async () => {
      const saleId = 'sale-u5-no-order';
      const sale = buildDraftSaleWithTotals(saleId, {
        unitPriceCents: 1000,
        quantity: 2,
      });
      saleRepo.findByIdForUpdate.mockResolvedValue(sale);
      productsService.getProductInfoForSale.mockResolvedValue({
        unitPriceCents: 1000,
      });
      productsService.decrementStockForCharge.mockResolvedValue([]);
      saleRepo.allocateNextFolio.mockResolvedValue('A-2605-000061');
      saleRepo.persistChargeConfirmation.mockResolvedValue([]);

      const result = await service.chargeDraft(
        saleId,
        'user-1',
        { method: 'cash', amountCents: 2000 },
        'idem-u5-no-order',
      );

      // subtotal === total === 2000; discount === 0 (no order promo).
      expect(result.subtotalCents).toBe(2000);
      expect(result.discountCents).toBe(0);
      expect(result.totalCents).toBe(2000);
      expect(saleRepo.persistChargeConfirmation).toHaveBeenCalledWith(
        expect.objectContaining({
          subtotalCents: 2000,
          discountCents: 0,
          totalCents: 2000,
        }),
      );
    });
  });
});
