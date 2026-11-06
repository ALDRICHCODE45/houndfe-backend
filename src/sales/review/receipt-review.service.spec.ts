import {
  DEFAULT_CUSTOMER_REJECTION_REASON,
  ReceiptReviewService,
} from './receipt-review.service';
import type {
  ReceiptReviewRecord,
  ReceiptReviewRepository,
} from './domain/receipt-review.repository';
import type { SalesService } from '../sales.service';
import type { ISaleRepository } from '../domain/sale.repository';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { OutboxWriterService } from '../../shared/outbox/outbox-writer.service';
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
    customerReason: null,
    createdAt: new Date('2026-06-13T10:01:00.000Z'),
    declaredAmountProvided: true,
    file: null,
    extracted: null,
    mismatch: null,
    sale: {
      id: 'sale-1',
      status: 'CONFIRMED',
      paymentStatus: 'PARTIAL',
      paidCents: 500,
      debtCents: 1500,
      totalCents: 2000,
      channel: 'ONLINE',
      folio: 'V-0001',
      customerName: 'Ana López',
    },
    ...overrides,
  };
}

function makeRepository() {
  return {
    findPendingForSale: jest.fn(),
    findPendingForTenant: jest.fn(),
    findById: jest.fn(),
    markConfirmed: jest.fn().mockResolvedValue(true),
    markRejected: jest.fn().mockResolvedValue(true),
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

function makeOutboxWriter() {
  return {
    publish: jest.fn().mockResolvedValue(undefined),
  } as jest.Mocked<Pick<OutboxWriterService, 'publish'>>;
}

function makeService() {
  const repository = makeRepository();
  const salesService = makeSalesService();
  const saleRepository = makeSaleRepository();
  const outboxWriter = makeOutboxWriter();
  const txClient = { outboxEvent: { create: jest.fn() } };
  const tenantPrisma = {
    getTenantId: jest.fn(() => 'tenant-1'),
    getClient: jest.fn(() => txClient),
  } as unknown as jest.Mocked<Pick<TenantPrismaService, 'getTenantId'>>;

  const service = new ReceiptReviewService(
    repository,
    salesService as unknown as SalesService,
    saleRepository as unknown as ISaleRepository,
    tenantPrisma as unknown as TenantPrismaService,
    outboxWriter as unknown as OutboxWriterService,
  );

  return {
    service,
    repository,
    salesService,
    saleRepository,
    tenantPrisma,
    outboxWriter,
    txClient,
  };
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

    it('blocks a lost confirmation claim before payment creation or outbox publication', async () => {
      const { service, repository, salesService, outboxWriter } = makeService();
      repository.findById.mockResolvedValue(makeReceipt());
      (repository.markConfirmed as jest.Mock).mockResolvedValue(false);

      await expect(
        service.confirm(
          'sale-1',
          'receipt-1',
          'reviewer-1',
          { amountCents: 2000 },
          'idem-claim-lost',
        ),
      ).rejects.toBeInstanceOf(ReceiptNotActionableError);

      expect(salesService.addPayment).not.toHaveBeenCalled();
      expect(outboxWriter.publish).not.toHaveBeenCalled();
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

    it('publishes receipt.confirmed with transfer, bot-origin, and reviewer audit facts inside the transaction', async () => {
      const { service, repository, salesService, outboxWriter, txClient } =
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

      await service.confirm(
        'sale-1',
        'receipt-1',
        'reviewer-1',
        { amountCents: 2000 },
        'idem-events-1',
      );

      expect(outboxWriter.publish).toHaveBeenCalledWith(
        txClient,
        'tenant-1',
        'ReceiptEvidence',
        'receipt-1',
        'receipt.confirmed',
        {
          receiptId: 'receipt-1',
          saleId: 'sale-1',
          tenantId: 'tenant-1',
          amountCents: 2000,
          paymentMethod: 'TRANSFER',
          origin: { kind: 'bot', channel: 'ONLINE' },
          validatedByUserId: 'reviewer-1',
          validatedAt: '2026-06-13T12:00:00.000Z',
          resultingPaymentStatus: 'PAID',
          occurredAt: '2026-06-13T12:00:00.000Z',
        },
      );
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
        DEFAULT_CUSTOMER_REJECTION_REASON,
      ]);
      expect(salesService.addPayment.mock.calls).toHaveLength(0);
    });

    it('stores the customer-safe reason separately from the internal reason', async () => {
      const { service, repository } = makeService();
      repository.findById.mockResolvedValue(makeReceipt());

      await service.reject('sale-1', 'receipt-1', 'reviewer-1', {
        reason: 'Posible fraude, referencia repetida',
        customerReason: 'No pudimos validar la referencia de tu transferencia.',
      });

      expect(repository.markRejected.mock.calls[0]).toEqual([
        'receipt-1',
        'tenant-1',
        'Posible fraude, referencia repetida',
        'No pudimos validar la referencia de tu transferencia.',
      ]);
    });

    it('blocks a lost rejection claim before outbox publication', async () => {
      const { service, repository, outboxWriter } = makeService();
      repository.findById.mockResolvedValue(makeReceipt());
      (repository.markRejected as jest.Mock).mockResolvedValue(false);

      await expect(
        service.reject('sale-1', 'receipt-1', 'reviewer-1', {
          reason: 'Duplicate receipt',
        }),
      ).rejects.toBeInstanceOf(ReceiptNotActionableError);

      expect(outboxWriter.publish).not.toHaveBeenCalled();
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

    it('publishes receipt.rejected with the reviewer audit fact and rejection reason inside the transaction', async () => {
      const { service, repository, outboxWriter, txClient } = makeService();
      repository.findById.mockResolvedValue(makeReceipt());

      await service.reject('sale-1', 'receipt-1', 'reviewer-1', {
        reason: 'Unreadable receipt',
      });

      expect(outboxWriter.publish).toHaveBeenCalledWith(
        txClient,
        'tenant-1',
        'ReceiptEvidence',
        'receipt-1',
        'receipt.rejected',
        {
          receiptId: 'receipt-1',
          saleId: 'sale-1',
          tenantId: 'tenant-1',
          validatedByUserId: 'reviewer-1',
          reason: 'Unreadable receipt',
          occurredAt: '2026-06-13T12:00:00.000Z',
        },
      );
    });
  });

  describe('deterministic competing review orchestration', () => {
    it('admits the rejection winner when an interleaved confirmation claim loses', async () => {
      const { service, repository, salesService, outboxWriter } = makeService();
      repository.findById.mockResolvedValue(makeReceipt());
      salesService.addPayment.mockResolvedValue({
        saleId: 'sale-1',
        paidCents: 2000,
        debtCents: 0,
        totalCents: 2000,
        paymentStatus: 'PAID',
        paymentIds: ['payment-1'],
      });

      let signalConfirmationClaim!: () => void;
      const confirmationClaimStarted = new Promise<void>((resolve) => {
        signalConfirmationClaim = resolve;
      });
      let releaseConfirmationClaim!: () => void;
      const confirmationClaimCanFinish = new Promise<void>((resolve) => {
        releaseConfirmationClaim = resolve;
      });

      (repository.markConfirmed as jest.Mock).mockImplementation(async () => {
        signalConfirmationClaim();
        await confirmationClaimCanFinish;
        return false;
      });
      (repository.markRejected as jest.Mock).mockResolvedValue(true);

      const confirmation = service.confirm(
        'sale-1',
        'receipt-1',
        'reviewer-1',
        { amountCents: 2000 },
        'idem-interleaved-confirm',
      );
      await confirmationClaimStarted;

      await service.reject('sale-1', 'receipt-1', 'reviewer-2', {
        reason: 'Duplicate receipt',
      });
      releaseConfirmationClaim();

      await expect(confirmation).rejects.toBeInstanceOf(
        ReceiptNotActionableError,
      );
      expect(salesService.addPayment).not.toHaveBeenCalled();
      expect(outboxWriter.publish).toHaveBeenCalledTimes(1);
      expect(outboxWriter.publish).toHaveBeenLastCalledWith(
        expect.anything(),
        'tenant-1',
        'ReceiptEvidence',
        'receipt-1',
        'receipt.rejected',
        expect.anything(),
      );
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
          declaredAmountProvided: true,
          file: null,
          extracted: null,
          mismatch: null,
          createdAt: new Date('2026-06-13T10:01:00.000Z'),
        },
      ]);
    });

    it('maps a private upload to relative file routes, extracted data and mismatch', async () => {
      const { service, repository } = makeService();
      repository.findPendingForSale.mockResolvedValue([
        makeReceipt({
          mediaUrl: '',
          declaredAmountCents: 0,
          declaredAmountProvided: false,
          file: {
            mimeType: 'application/pdf',
            sizeBytes: 183422,
            previewStatus: 'READY',
            purged: false,
          },
          extracted: { amountCents: 1500, bank: 'BBVA', confidence: 0.9 },
          mismatch: { debtCents: 1500, extractedDiffCents: 0, flagged: false },
        }),
      ]);

      const [item] = await service.listPending('sale-1');

      expect(item).toMatchObject({
        mediaUrl: '',
        declaredAmountCents: 0,
        declaredAmountProvided: false,
        file: {
          mimeType: 'application/pdf',
          sizeBytes: 183422,
          previewStatus: 'READY',
          originalUrl: '/sales/sale-1/receipts/receipt-1/file',
          previewUrl: '/sales/sale-1/receipts/receipt-1/preview',
        },
        extracted: { amountCents: 1500, bank: 'BBVA', confidence: 0.9 },
        mismatch: { debtCents: 1500, extractedDiffCents: 0, flagged: false },
      });
    });

    it('drops the preview route when the preview is unavailable and both routes once purged', async () => {
      const { service, repository } = makeService();
      repository.findPendingForSale.mockResolvedValue([
        makeReceipt({
          file: {
            mimeType: 'application/pdf',
            sizeBytes: 10,
            previewStatus: 'UNAVAILABLE',
            purged: false,
          },
        }),
        makeReceipt({
          id: 'receipt-2',
          file: {
            mimeType: 'image/png',
            sizeBytes: 10,
            previewStatus: 'READY',
            purged: true,
          },
        }),
      ]);

      const [unavailable, purged] = await service.listPending('sale-1');

      expect(unavailable.file).toMatchObject({
        originalUrl: '/sales/sale-1/receipts/receipt-1/file',
        previewUrl: null,
      });
      expect(purged.file).toMatchObject({
        originalUrl: null,
        previewUrl: null,
      });
    });

    it('changes the v1 queue shape only additively (FE strict decoders)', async () => {
      const { service, repository } = makeService();
      repository.findPendingForSale.mockResolvedValue([makeReceipt()]);

      const [item] = await service.listPending('sale-1');

      // Keys and types the FE decodes today: never renamed, removed or retyped.
      const V1_KEYS: Record<string, string> = {
        id: 'string',
        saleId: 'string',
        mediaUrl: 'string',
        declaredAmountCents: 'number',
        declaredDate: 'object',
        declaredReference: 'string',
        status: 'string',
        salePaymentStatus: 'string',
        salePaidCents: 'number',
        saleDebtCents: 'number',
        saleTotalCents: 'number',
      };
      for (const [key, type] of Object.entries(V1_KEYS)) {
        expect([key, typeof (item as Record<string, unknown>)[key]]).toEqual([
          key,
          type,
        ]);
      }
      expect(Object.keys(item).sort()).toEqual(
        [
          ...Object.keys(V1_KEYS),
          'declaredAmountProvided',
          'file',
          'extracted',
          'mismatch',
          'createdAt',
        ].sort(),
      );
    });
  });

  describe('listPendingForTenant', () => {
    it('pages the tenant-wide queue oldest first with an opaque cursor', async () => {
      const { service, repository } = makeService();
      const first = makeReceipt({ id: 'receipt-1' });
      const second = makeReceipt({
        id: 'receipt-2',
        createdAt: new Date('2026-06-13T10:02:00.000Z'),
      });
      const third = makeReceipt({
        id: 'receipt-3',
        createdAt: new Date('2026-06-13T10:03:00.000Z'),
      });
      repository.findPendingForTenant.mockResolvedValue([first, second, third]);

      const page = await service.listPendingForTenant({ limit: 2 });

      expect(repository.findPendingForTenant.mock.calls[0]).toEqual([
        'tenant-1',
        { limit: 3, after: null },
      ]);
      expect(page.items.map((item) => item.id)).toEqual([
        'receipt-1',
        'receipt-2',
      ]);
      expect(page.items[0]).toMatchObject({
        saleFolio: 'V-0001',
        customerName: 'Ana López',
      });
      expect(page.nextCursor).toEqual(expect.any(String));

      repository.findPendingForTenant.mockResolvedValue([third]);
      const next = await service.listPendingForTenant({
        limit: 2,
        cursor: page.nextCursor as string,
      });

      expect(repository.findPendingForTenant.mock.calls[1]).toEqual([
        'tenant-1',
        {
          limit: 3,
          after: {
            createdAt: new Date('2026-06-13T10:02:00.000Z'),
            id: 'receipt-2',
          },
        },
      ]);
      expect(next).toMatchObject({ nextCursor: null });
    });

    it('defaults the limit to 25 and rejects a malformed cursor', async () => {
      const { service, repository } = makeService();
      repository.findPendingForTenant.mockResolvedValue([]);

      await expect(service.listPendingForTenant({})).resolves.toEqual({
        items: [],
        nextCursor: null,
      });
      expect(repository.findPendingForTenant.mock.calls[0]).toEqual([
        'tenant-1',
        { limit: 26, after: null },
      ]);
      await expect(
        service.listPendingForTenant({ cursor: 'not-a-cursor' }),
      ).rejects.toMatchObject({ code: 'INVALID_RECEIPT_CURSOR' });
    });
  });
});
