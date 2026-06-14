import { ReceiptReviewService } from './receipt-review.service';
import type {
  ReceiptReviewRecord,
  ReceiptReviewRepository,
} from './domain/receipt-review.repository';
import type { SalesService } from '../sales.service';
import type { ISaleRepository } from '../domain/sale.repository';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  ReceiptNotActionableError,
  SaleNotReviewableError,
} from './domain/receipt-review.errors';

function makeReceipt(
  overrides: Partial<ReceiptReviewRecord> = {},
): ReceiptReviewRecord {
  return {
    id: 'receipt-1',
    saleId: 'sale-1',
    tenantId: 'tenant-1',
    mediaUrl: 'https://spaces.test/receipt.jpg',
    declaredAmountCents: 1500,
    declaredDate: new Date('2026-06-13T10:00:00.000Z'),
    declaredReference: 'TRX-1',
    status: 'PENDING',
    confirmedByUserId: null,
    confirmedAt: null,
    rejectionReason: null,
    createdAt: new Date('2026-06-13T10:01:00.000Z'),
    sale: {
      id: 'sale-1',
      status: 'CONFIRMED',
      paymentStatus: 'PARTIAL',
      paidCents: 500,
      debtCents: 1500,
      totalCents: 2000,
      channel: 'ONLINE',
    },
    ...overrides,
  };
}

function makeRepository() {
  return {
    findPendingForSale: jest.fn(),
    findById: jest.fn(),
    markConfirmed: jest.fn(),
    markRejected: jest.fn(),
  } as jest.Mocked<ReceiptReviewRepository>;
}

function makeSalesService() {
  return {
    addPayment: jest.fn(),
  } as unknown as jest.Mocked<Pick<SalesService, 'addPayment'>>;
}

function makeSaleRepository() {
  return {
    runInTransaction: jest.fn(async (work: () => Promise<unknown>) => work()),
  } as jest.Mocked<Pick<ISaleRepository, 'runInTransaction'>>;
}

function makeService() {
  const repository = makeRepository();
  const salesService = makeSalesService();
  const saleRepository = makeSaleRepository();
  const tenantPrisma = {
    getTenantId: jest.fn(() => 'tenant-1'),
  } as unknown as jest.Mocked<Pick<TenantPrismaService, 'getTenantId'>>;

  const service = new ReceiptReviewService(
    repository,
    salesService as unknown as SalesService,
    saleRepository as unknown as ISaleRepository,
    tenantPrisma as unknown as TenantPrismaService,
  );

  return { service, repository, salesService, saleRepository, tenantPrisma };
}

describe('ReceiptReviewService', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-13T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('confirm', () => {
    it('confirms a receipt with the real full amount through reviewer payment routing', async () => {
      const { service, repository, salesService, saleRepository } =
        makeService();
      repository.findById.mockResolvedValue(makeReceipt());
      salesService.addPayment.mockResolvedValue({
        saleId: 'sale-1',
        paidCents: 2000,
        debtCents: 0,
        totalCents: 2000,
        paymentStatus: 'PAID',
        paymentIds: ['payment-1'],
      });

      const result = await service.confirm(
        'sale-1',
        'receipt-1',
        'reviewer-1',
        { amountCents: 2000 },
        'idem-1',
      );

      expect(saleRepository.runInTransaction.mock.calls).toHaveLength(1);
      expect(salesService.addPayment.mock.calls[0]).toEqual([
        'sale-1',
        'reviewer-1',
        { method: 'transfer', amountCents: 2000, reference: 'TRX-1' },
        'idem-1',
        'reviewer',
      ]);
      expect(repository.markConfirmed.mock.calls[0]).toEqual([
        'receipt-1',
        'tenant-1',
        'reviewer-1',
        new Date('2026-06-13T12:00:00.000Z'),
      ]);
      expect(result.paymentStatus).toBe('PAID');
    });

    it('uses the real confirmed amount when it differs from the declared amount', async () => {
      const { service, repository, salesService } = makeService();
      repository.findById.mockResolvedValue(
        makeReceipt({ declaredAmountCents: 3000 }),
      );
      salesService.addPayment.mockResolvedValue({
        saleId: 'sale-1',
        paidCents: 1700,
        debtCents: 300,
        totalCents: 2000,
        paymentStatus: 'PARTIAL',
        paymentIds: ['payment-1'],
      });

      await service.confirm(
        'sale-1',
        'receipt-1',
        'reviewer-1',
        { amountCents: 1200 },
        'idem-2',
      );

      expect(salesService.addPayment.mock.calls[0]).toEqual([
        'sale-1',
        'reviewer-1',
        { method: 'transfer', amountCents: 1200, reference: 'TRX-1' },
        'idem-2',
        'reviewer',
      ]);
    });

    it('leaves the sale partial when the confirmed amount does not clear the balance', async () => {
      const { service, repository, salesService } = makeService();
      repository.findById.mockResolvedValue(makeReceipt());
      salesService.addPayment.mockResolvedValue({
        saleId: 'sale-1',
        paidCents: 1200,
        debtCents: 800,
        totalCents: 2000,
        paymentStatus: 'PARTIAL',
        paymentIds: ['payment-1'],
      });

      const result = await service.confirm(
        'sale-1',
        'receipt-1',
        'reviewer-1',
        { amountCents: 700 },
        'idem-3',
      );

      expect(result.paymentStatus).toBe('PARTIAL');
      expect(result.debtCents).toBe(800);
    });

    it('blocks confirmation for non-pending receipts before payment creation', async () => {
      const { service, repository, salesService, saleRepository } =
        makeService();
      repository.findById.mockResolvedValue(
        makeReceipt({ status: 'CONFIRMED' }),
      );

      await expect(
        service.confirm(
          'sale-1',
          'receipt-1',
          'reviewer-1',
          { amountCents: 2000 },
          'idem-4',
        ),
      ).rejects.toBeInstanceOf(ReceiptNotActionableError);

      expect(saleRepository.runInTransaction.mock.calls).toHaveLength(0);
      expect(salesService.addPayment.mock.calls).toHaveLength(0);
      expect(repository.markConfirmed.mock.calls).toHaveLength(0);
    });

    it('blocks receipts whose sale is not confirmed', async () => {
      const { service, repository, salesService } = makeService();
      repository.findById.mockResolvedValue(
        makeReceipt({ sale: { ...makeReceipt().sale, status: 'DRAFT' } }),
      );

      await expect(
        service.confirm(
          'sale-1',
          'receipt-1',
          'reviewer-1',
          { amountCents: 2000 },
          'idem-5',
        ),
      ).rejects.toBeInstanceOf(SaleNotReviewableError);

      expect(salesService.addPayment.mock.calls).toHaveLength(0);
    });

    it('blocks confirmation for already paid sales to avoid credit payment status', async () => {
      const { service, repository, salesService } = makeService();
      repository.findById.mockResolvedValue(
        makeReceipt({
          sale: {
            ...makeReceipt().sale,
            paymentStatus: 'PAID',
            debtCents: 0,
            paidCents: 2000,
          },
        }),
      );

      await expect(
        service.confirm(
          'sale-1',
          'receipt-1',
          'reviewer-1',
          { amountCents: 100 },
          'idem-6',
        ),
      ).rejects.toBeInstanceOf(SaleNotReviewableError);

      expect(salesService.addPayment.mock.calls).toHaveLength(0);
    });
  });

  describe('reject', () => {
    it('rejects a pending receipt with a reason and leaves the sale untouched', async () => {
      const { service, repository, salesService, saleRepository } =
        makeService();
      repository.findById.mockResolvedValue(makeReceipt());

      await service.reject('sale-1', 'receipt-1', 'reviewer-1', {
        reason: 'Unreadable receipt',
      });

      expect(saleRepository.runInTransaction.mock.calls).toHaveLength(1);
      expect(repository.markRejected.mock.calls[0]).toEqual([
        'receipt-1',
        'tenant-1',
        'Unreadable receipt',
      ]);
      expect(salesService.addPayment.mock.calls).toHaveLength(0);
    });

    it('blocks rejection for non-pending receipts', async () => {
      const { service, repository, salesService, saleRepository } =
        makeService();
      repository.findById.mockResolvedValue(
        makeReceipt({ status: 'REJECTED' }),
      );

      await expect(
        service.reject('sale-1', 'receipt-1', 'reviewer-1', {
          reason: 'Duplicate receipt',
        }),
      ).rejects.toBeInstanceOf(ReceiptNotActionableError);

      expect(saleRepository.runInTransaction.mock.calls).toHaveLength(0);
      expect(salesService.addPayment.mock.calls).toHaveLength(0);
    });
  });

  describe('listPending', () => {
    it('returns pending queue items with mediaUrl for a sale', async () => {
      const { service, repository } = makeService();
      repository.findPendingForSale.mockResolvedValue([makeReceipt()]);

      const result = await service.listPending('sale-1');

      expect(repository.findPendingForSale.mock.calls[0]).toEqual([
        'sale-1',
        'tenant-1',
      ]);
      expect(result).toEqual([
        {
          id: 'receipt-1',
          saleId: 'sale-1',
          mediaUrl: 'https://spaces.test/receipt.jpg',
          declaredAmountCents: 1500,
          declaredDate: new Date('2026-06-13T10:00:00.000Z'),
          declaredReference: 'TRX-1',
          status: 'PENDING',
          salePaymentStatus: 'PARTIAL',
          salePaidCents: 500,
          saleDebtCents: 1500,
          saleTotalCents: 2000,
        },
      ]);
    });
  });
});
