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
import {
  SaleCustomerAssignedEvent,
  SaleCustomerClearedEvent,
  SaleShippingAddressClearedEvent,
  SaleShippingAddressSetEvent,
} from './domain/events/sale.events';

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
    runInTransaction: jest.fn(async (cb: any) => cb()),
    allocateNextFolio: jest.fn(),
    persistChargeConfirmation: jest.fn(),
    persistCollectedPayment: jest.fn(),
    findManyConfirmed: jest.fn(),
    countConfirmed: jest.fn(),
    groupByPaymentStatusConfirmed: jest.fn(),
    countNotDeliveredConfirmed: jest.fn(),
    findDraftResponseById: jest.fn(),
    ...overrides,
  } as jest.Mocked<ISaleRepository>;
}

function makeMockProductsService() {
  return {
    getProductInfoForSale: jest.fn(),
    checkStockAvailability: jest.fn(),
    getApplicablePrices: jest.fn(),
    resolveListPrice: jest.fn(),
    decrementStockForCharge: jest.fn(),
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

function createService(
  saleRepo: ISaleRepository,
  productsService: ProductsService,
  eventEmitter: EventEmitter2,
  outboxWriter: Pick<OutboxWriterService, 'publish'>,
  tenantPrisma: Pick<TenantPrismaService, 'getTenantId' | 'getClient'>,
) {
  return new SalesService(
    saleRepo,
    productsService,
    eventEmitter,
    outboxWriter,
    tenantPrisma as TenantPrismaService,
  );
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('SalesService', () => {
  let saleRepo: ReturnType<typeof makeMockSaleRepo>;
  let productsService: ReturnType<typeof makeMockProductsService>;
  let eventEmitter: ReturnType<typeof makeMockEventEmitter>;
  let outboxWriter: ReturnType<typeof makeMockOutboxWriter>;
  let tenantPrisma: Pick<TenantPrismaService, 'getTenantId' | 'getClient'>;
  let service: SalesService;

  beforeEach(() => {
    saleRepo = makeMockSaleRepo();
    productsService = makeMockProductsService();
    eventEmitter = makeMockEventEmitter();
    outboxWriter = makeMockOutboxWriter();
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
    saleRepo.persistCollectedPayment.mockResolvedValue({
      paymentId: 'payment-1',
      paidCents: 4000,
      debtCents: 1000,
      paymentStatus: 'PARTIAL',
      totalCents: 5000,
    });
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
      )) as { paymentStatus: string; paidCents: number; debtCents: number };

      expect(result.paymentStatus).toBe('PARTIAL');
      expect(result.paidCents).toBe(4000);
      expect(result.debtCents).toBe(1000);
    });

    it('emits only sale.payment.received outbox event for partial addPayment', async () => {
      const sale = buildConfirmedSale('sale-payment-outbox-partial', 'user-1', 5000);
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
      const sale = buildConfirmedSale('sale-payment-outbox-full', 'user-1', 5000);
      saleRepo.findByIdForUpdate.mockResolvedValue(sale);
      saleRepo.persistCollectedPayment.mockResolvedValue({
        paymentId: 'payment-final',
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
      saleRepo.persistCollectedPayment.mockRejectedValue(
        new BusinessRuleViolationError('PAYMENT_EXCEEDS_DEBT', 'PAYMENT_EXCEEDS_DEBT'),
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
      saleRepo.persistCollectedPayment.mockRejectedValue(
        new BusinessRuleViolationError('NO_OUTSTANDING_DEBT', 'NO_OUTSTANDING_DEBT'),
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
      const sale = buildConfirmedSale('sale-payment-credit-method', 'user-1', 5000);
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
      const sale = buildConfirmedSale('sale-payment-tenant-404', 'user-1', 5000);
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
  });

  describe('draft customer and shipping address mutations', () => {
    const makeDraftSale = (overrides?: { customerId?: string | null; shippingAddressId?: string | null }) =>
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
        customer: { findUnique: jest.fn().mockResolvedValue({ id: draftResponse.customer.id }) },
        customerAddress: {
          findUnique: jest.fn().mockResolvedValue({
            id: draftResponse.shippingAddress.id,
            customerId: draftResponse.customer.id,
          }),
        },
      };
      tenantPrisma.getClient = jest.fn(() => prismaClient as never);
      saleRepo.findDraftResponseById.mockResolvedValue(draftResponse as never);

      const result = await service.assignCustomer(
        sale.id,
        sale.userId,
        {
          customerId: draftResponse.customer.id,
          shippingAddressId: draftResponse.shippingAddress.id,
        },
      );

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
      productsService.decrementStockForCharge.mockResolvedValue(undefined);
      saleRepo.allocateNextFolio.mockResolvedValue('A-2605-000014');
      saleRepo.persistChargeConfirmation.mockResolvedValue([]);
    };

    it('accepts new payments[] shape and computes totals', async () => {
      const sale = buildDraftSale('sale-charge-array-ok', 'user-1', 'customer-1');
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
      const sale = buildDraftSale('sale-charge-outbox-full', 'user-1', 'customer-1');
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
        { payments: [{ method: 'cash', amountCents: 1000 }, { method: 'card_debit', amountCents: 1000, reference: 'REF-1' }] } as never,
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
      const sale = buildDraftSale('sale-charge-outbox-partial', 'user-1', 'customer-1');
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
      const sale = buildDraftSale('sale-charge-mixed-shape', 'user-1', 'customer-1');
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
      const sale = buildDraftSale('sale-charge-array-credit', 'user-1', 'customer-1');
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
      const sale = buildDraftSale('sale-charge-array-reference', 'user-1', 'customer-1');
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
      const sale = buildDraftSale('sale-charge-array-too-many', 'user-1', 'customer-1');
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
      const sale = buildDraftSale('sale-charge-array-empty-credit', 'user-1', 'customer-1');
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
      const sale = buildDraftSale('sale-charge-array-card-overpay', 'user-1', 'customer-1');
      setupHappyPathDraft(sale);

      await expect(
        service.chargeDraft(
          sale.id,
          'user-1',
          {
            payments: [{ method: 'card_debit', amountCents: 2500, reference: 'REF-1' }],
          } as never,
          'idem-array-card-overpay',
        ),
      ).rejects.toThrow('PAYMENT_AMOUNT_INVALID');
    });

    it('computes changeDueCents from aggregated payments', async () => {
      const sale = buildDraftSale('sale-charge-array-change', 'user-1', 'customer-1');
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
      const sale = buildDraftSale('sale-charge-array-idempotency', 'user-1', 'customer-1');
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
      saleRepo.persistChargeConfirmation = jest.fn().mockResolvedValue(undefined) as any;
      saleRepo.runInTransaction = jest
        .fn()
        .mockImplementation(async (cb: any) => cb()) as any;
      (saleRepo as any).decrementStockForCharge = jest.fn().mockResolvedValue(undefined);

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
      productsService.decrementStockForCharge.mockResolvedValue(undefined);
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
        }),
      );
    });

    it('accepts partial non-credit payment and marks PARTIAL', async () => {
      const sale = buildDraftSale('sale-charge-partial', 'user-1', 'customer-1');
      saleRepo.findByIdForUpdate.mockResolvedValue(sale);
      productsService.getProductInfoForSale.mockResolvedValue({
        unitPriceCents: 1000,
      });
      productsService.decrementStockForCharge.mockResolvedValue(undefined);
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
      productsService.decrementStockForCharge.mockResolvedValue(undefined);
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
      const sale = buildDraftSale('sale-charge-underpay', 'user-1', 'customer-1');
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
      const sale = Sale.create({ id: 'sale-charge-custom-price', userId: 'user-1' });
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
      productsService.decrementStockForCharge.mockResolvedValue(undefined);
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

      (saleRepo as any).acquireChargeIdempotency = jest
        .fn()
        .mockResolvedValue({
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
      productsService.decrementStockForCharge.mockResolvedValue(undefined);
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

      expect((saleRepo as any).markChargeIdempotencySucceeded).toHaveBeenCalledWith(
        'idem-row-1',
        sale.id,
        result,
      );
    });
  });

  describe('item discount use-cases', () => {
    it('applies item discount and emits event', async () => {
      const sale = Sale.create({ id: 'sale-discount', userId: 'user-1' });
      sale.addItem({
        id: 'item-1', saleId: 'sale-discount', productId: 'prod-1', variantId: null,
        productName: 'Prod', variantName: null, quantity: 1, unitPriceCents: 1000, unitPriceCurrency: 'MXN',
      });
      saleRepo.findById.mockResolvedValue(sale);

      const result = await service.applyItemDiscount('sale-discount', 'item-1', {
        type: 'percentage',
        percent: 15,
        discountTitle: 'promo',
      }, 'user-1');

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
        id: 'item-1', saleId: 'sale-discount-2', productId: 'prod-1', variantId: null,
        productName: 'Prod', variantName: null, quantity: 1, unitPriceCents: 1000, unitPriceCurrency: 'MXN',
      });
      sale.applyItemDiscount('item-1', { type: 'amount', amountCents: 100 });
      saleRepo.findById.mockResolvedValue(sale);

      const result = await service.removeItemDiscount('sale-discount-2', 'item-1', 'user-1');
      expect(result.items[0].discountType).toBeNull();
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'sale.item.discount.removed',
        expect.objectContaining({ saleId: 'sale-discount-2', itemId: 'item-1' }),
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
        expect.objectContaining({ saleId: 'sale-global', itemId: 'item-eligible' }),
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
      sale.applyItemDiscount('item-has-discount', { type: 'percentage', percent: 10 });
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
        expect.objectContaining({ saleId: 'sale-skip-strat', itemId: 'item-no-discount' }),
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
      sale.applyItemDiscount('item-discounted', { type: 'amount', amountCents: 100 });
      saleRepo.findById.mockResolvedValue(sale);

      const result = await service.removeGlobalDiscount('sale-remove-global', 'user-1');

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
      const sale = Sale.create({ id: 'sale-remove-idempotent', userId: 'user-1' });
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
      const sale = Sale.create({ id: 'sale-remove-forbidden', userId: 'owner-1' });
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

      const result = await service.listSales({ page: 2, limit: 1, paymentStatus: 'PAID' } as any);

      expect(result.data).toHaveLength(1);
      expect(result.pagination).toEqual({ page: 2, limit: 1, total: 7, totalPages: 7 });
      expect(result.counts).toEqual({ all: 7, pendingPayments: 3, notDelivered: 3 });
      expect(saleRepo.findManyConfirmed).toHaveBeenCalledWith(
        expect.objectContaining({ paymentStatus: 'PAID', page: 2, limit: 1 }),
      );
      expect(saleRepo.countConfirmed).toHaveBeenCalledWith(expect.objectContaining({}));
      expect(saleRepo.groupByPaymentStatusConfirmed).toHaveBeenCalledWith(expect.objectContaining({}));
      expect(saleRepo.countNotDeliveredConfirmed).toHaveBeenCalledWith(expect.objectContaining({}));
    });

    it('keeps counts independent from tab filters', async () => {
      saleRepo.findManyConfirmed.mockResolvedValue([] as any);
      saleRepo.countConfirmed.mockResolvedValue(3);
      saleRepo.groupByPaymentStatusConfirmed.mockResolvedValue([
        { paymentStatus: 'PAID', _count: { _all: 1 } },
        { paymentStatus: 'PARTIAL', _count: { _all: 2 } },
      ] as any);
      saleRepo.countNotDeliveredConfirmed.mockResolvedValue(1);

      await service.listSales({ paymentStatus: 'PAID', deliveryStatus: 'DELIVERED' } as any);

      expect(saleRepo.findManyConfirmed).toHaveBeenCalledWith(
        expect.objectContaining({ paymentStatus: 'PAID', deliveryStatus: 'DELIVERED' }),
      );
      expect(saleRepo.countConfirmed).toHaveBeenCalledWith(
        expect.not.objectContaining({ paymentStatus: expect.anything(), deliveryStatus: expect.anything() }),
      );
      expect(saleRepo.groupByPaymentStatusConfirmed).toHaveBeenCalledWith(
        expect.not.objectContaining({ paymentStatus: expect.anything(), deliveryStatus: expect.anything() }),
      );
      expect(saleRepo.countNotDeliveredConfirmed).toHaveBeenCalledWith(
        expect.not.objectContaining({ paymentStatus: expect.anything(), deliveryStatus: expect.anything() }),
      );
    });
  });

  describe('getSaleDetail', () => {
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
          },
          {
            method: 'TRANSFER',
            amountCents: 800,
            tenderedCents: 800,
            changeCents: 0,
            reference: 'TRF-2',
            paidAt: new Date('2026-05-08T10:30:00.000Z'),
            createdAt: new Date('2026-05-08T10:30:00.000Z'),
          },
        ],
      } as any);

      const result = await service.getSaleDetail(
        'b5e2b8fd-bdfd-471f-b687-ec340d578885',
      );

      expect(result.id).toBe('b5e2b8fd-bdfd-471f-b687-ec340d578885');
      expect(result.timeline).toHaveLength(4);
      expect(result.timeline[1]).toEqual({
        type: 'PAYMENT_RECEIVED',
        at: '2026-05-08T10:20:00.000Z',
      });
      expect(result.timeline[2]).toEqual({
        type: 'PAYMENT_RECEIVED',
        at: '2026-05-08T10:30:00.000Z',
      });
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
});
