import { PrismaReceiptReviewRepository } from './prisma-receipt-review.repository';
import type { ReceiptReviewRepository } from '../domain/receipt-review.repository';
import type { TenantPrismaService } from '../../../shared/prisma/tenant-prisma.service';

const receiptSaleInclude = {
  sale: {
    select: {
      id: true,
      status: true,
      paymentStatus: true,
      paidCents: true,
      debtCents: true,
      totalCents: true,
      channel: true,
      folio: true,
      customer: { select: { firstName: true, lastName: true } },
    },
  },
};

function makeMockPrisma() {
  return {
    receiptEvidence: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn(),
    },
  } as const;
}

describe('PrismaReceiptReviewRepository', () => {
  it('implements the receipt review repository port', () => {
    const tenantPrisma = {
      getClient: jest.fn().mockReturnValue(makeMockPrisma()),
    } as unknown as TenantPrismaService;
    const repository: ReceiptReviewRepository =
      new PrismaReceiptReviewRepository(tenantPrisma);

    expect(typeof repository.findPendingForSale).toBe('function');
    expect(typeof repository.findById).toBe('function');
    expect(typeof repository.markConfirmed).toBe('function');
    expect(typeof repository.markRejected).toBe('function');
  });

  it('lists tenant-scoped pending receipts for the sale queue', async () => {
    const client = makeMockPrisma();
    const tenantPrisma = {
      getClient: jest.fn().mockReturnValue(client),
    } as unknown as TenantPrismaService;
    const repository = new PrismaReceiptReviewRepository(tenantPrisma);

    client.receiptEvidence.findMany.mockResolvedValue([
      {
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
          debtCents: 1000,
          totalCents: 1500,
          channel: 'ONLINE',
        },
      },
    ]);

    const result = await repository.findPendingForSale('sale-1', 'tenant-1');

    expect(client.receiptEvidence.findMany).toHaveBeenCalledWith({
      where: {
        saleId: 'sale-1',
        tenantId: 'tenant-1',
        status: 'PENDING',
        sale: { status: 'CONFIRMED' },
      },
      orderBy: { createdAt: 'asc' },
      include: receiptSaleInclude,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('receipt-1');
    expect(result[0]?.mediaUrl).toBe('https://spaces.test/receipt.jpg');
    expect(result[0]?.sale.paymentStatus).toBe('PARTIAL');
  });

  it('keeps the queue shape for private uploads without URL or declared amount', async () => {
    const client = makeMockPrisma();
    const tenantPrisma = {
      getClient: jest.fn().mockReturnValue(client),
    } as unknown as TenantPrismaService;
    const repository = new PrismaReceiptReviewRepository(tenantPrisma);
    client.receiptEvidence.findFirst.mockResolvedValue({
      id: 'receipt-2',
      saleId: 'sale-1',
      tenantId: 'tenant-1',
      mediaUrl: null,
      declaredAmountCents: null,
      declaredDate: null,
      declaredReference: null,
      status: 'PENDING',
      confirmedByUserId: null,
      confirmedAt: null,
      rejectionReason: null,
      createdAt: new Date('2026-11-05T10:00:00.000Z'),
      sale: {
        id: 'sale-1',
        status: 'CONFIRMED',
        paymentStatus: 'CREDIT',
        paidCents: 0,
        debtCents: 1000,
        totalCents: 1000,
        channel: 'ONLINE',
      },
    });

    const result = await repository.findById('receipt-2', 'tenant-1');

    // Strict FE decoders keep string/number; the new keys carry the truth.
    expect(result?.mediaUrl).toBe('');
    expect(result?.declaredAmountCents).toBe(0);
    expect(result?.declaredAmountProvided).toBe(false);
  });

  it('maps private file metadata, extracted, mismatch and the sale header', async () => {
    const client = makeMockPrisma();
    const tenantPrisma = {
      getClient: jest.fn().mockReturnValue(client),
    } as unknown as TenantPrismaService;
    const repository = new PrismaReceiptReviewRepository(tenantPrisma);
    client.receiptEvidence.findFirst.mockResolvedValue({
      id: 'receipt-3',
      saleId: 'sale-1',
      tenantId: 'tenant-1',
      mediaUrl: null,
      declaredAmountCents: 4000,
      declaredDate: null,
      declaredReference: null,
      storageKey: 'receipts/tenant-1/sale-1/k.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1234,
      previewStatus: 'READY',
      extracted: { amountCents: 10000, bank: 'BBVA' },
      mismatch: { debtCents: 10000, declaredDiffCents: -6000, flagged: true },
      purgedAt: null,
      status: 'PENDING',
      confirmedByUserId: null,
      confirmedAt: null,
      rejectionReason: null,
      customerReason: null,
      createdAt: new Date('2026-11-05T10:00:00.000Z'),
      sale: {
        id: 'sale-1',
        status: 'CONFIRMED',
        paymentStatus: 'CREDIT',
        paidCents: 0,
        debtCents: 10000,
        totalCents: 10000,
        channel: 'ONLINE',
        folio: 'V-0042',
        customer: { firstName: 'Ana', lastName: 'López' },
      },
    });

    const result = await repository.findById('receipt-3', 'tenant-1');

    expect(result).toMatchObject({
      declaredAmountProvided: true,
      file: {
        mimeType: 'application/pdf',
        sizeBytes: 1234,
        previewStatus: 'READY',
        purged: false,
      },
      extracted: { amountCents: 10000, bank: 'BBVA' },
      mismatch: { debtCents: 10000, declaredDiffCents: -6000, flagged: true },
      customerReason: null,
      sale: { folio: 'V-0042', customerName: 'Ana López' },
    });
  });

  it('keeps file metadata for purged rows and null for legacy URL rows', async () => {
    const client = makeMockPrisma();
    const tenantPrisma = {
      getClient: jest.fn().mockReturnValue(client),
    } as unknown as TenantPrismaService;
    const repository = new PrismaReceiptReviewRepository(tenantPrisma);
    const base = {
      saleId: 'sale-1',
      tenantId: 'tenant-1',
      declaredAmountCents: 100,
      declaredDate: null,
      declaredReference: null,
      previewStatus: null,
      extracted: null,
      mismatch: null,
      status: 'PENDING',
      confirmedByUserId: null,
      confirmedAt: null,
      rejectionReason: null,
      customerReason: null,
      createdAt: new Date('2026-11-05T10:00:00.000Z'),
      sale: {
        id: 'sale-1',
        status: 'CONFIRMED',
        paymentStatus: 'CREDIT',
        paidCents: 0,
        debtCents: 100,
        totalCents: 100,
        channel: 'ONLINE',
        folio: null,
        customer: null,
      },
    };
    client.receiptEvidence.findMany.mockResolvedValue([
      {
        ...base,
        id: 'legacy',
        mediaUrl: 'https://legacy/r.jpg',
        storageKey: null,
        mimeType: null,
        sizeBytes: null,
        purgedAt: null,
      },
      {
        ...base,
        id: 'purged',
        mediaUrl: null,
        storageKey: null,
        mimeType: 'image/png',
        sizeBytes: 10,
        purgedAt: new Date('2031-11-06T00:00:00.000Z'),
      },
    ]);

    const [legacy, purged] = await repository.findPendingForSale(
      'sale-1',
      'tenant-1',
    );

    expect(legacy.file).toBeNull();
    expect(legacy.sale).toMatchObject({ folio: null, customerName: null });
    expect(purged.file).toEqual({
      mimeType: 'image/png',
      sizeBytes: 10,
      previewStatus: 'UNAVAILABLE',
      purged: true,
    });
  });

  it('lists the tenant-wide pending queue oldest first after a keyset position', async () => {
    const client = makeMockPrisma();
    const tenantPrisma = {
      getClient: jest.fn().mockReturnValue(client),
    } as unknown as TenantPrismaService;
    const repository = new PrismaReceiptReviewRepository(tenantPrisma);
    client.receiptEvidence.findMany.mockResolvedValue([]);
    const createdAt = new Date('2026-11-05T10:00:00.000Z');

    await repository.findPendingForTenant('tenant-1', {
      limit: 26,
      after: { createdAt, id: 'receipt-9' },
    });

    expect(client.receiptEvidence.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-1',
        status: 'PENDING',
        sale: { status: 'CONFIRMED' },
        OR: [
          { createdAt: { gt: createdAt } },
          { createdAt, id: { gt: 'receipt-9' } },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 26,
      include: receiptSaleInclude,
    });
  });

  it('loads one tenant-scoped receipt with sale state for actions', async () => {
    const client = makeMockPrisma();
    const tenantPrisma = {
      getClient: jest.fn().mockReturnValue(client),
    } as unknown as TenantPrismaService;
    const repository = new PrismaReceiptReviewRepository(tenantPrisma);

    client.receiptEvidence.findFirst.mockResolvedValue({
      id: 'receipt-1',
      saleId: 'sale-1',
      tenantId: 'tenant-1',
      mediaUrl: 'https://spaces.test/receipt.jpg',
      declaredAmountCents: 2000,
      declaredDate: null,
      declaredReference: null,
      status: 'PENDING',
      confirmedByUserId: null,
      confirmedAt: null,
      rejectionReason: null,
      createdAt: new Date('2026-06-13T10:01:00.000Z'),
      sale: {
        id: 'sale-1',
        status: 'CONFIRMED',
        paymentStatus: 'PARTIAL',
        paidCents: 0,
        debtCents: 2000,
        totalCents: 2000,
        channel: 'ONLINE',
      },
    });

    const result = await repository.findById('receipt-1', 'tenant-1');

    expect(client.receiptEvidence.findFirst).toHaveBeenCalledWith({
      where: { id: 'receipt-1', tenantId: 'tenant-1' },
      include: receiptSaleInclude,
    });
    expect(result?.sale.status).toBe('CONFIRMED');
  });

  it('returns whether the tenant-scoped confirmation claim updated a pending receipt', async () => {
    const client = makeMockPrisma();
    const tenantPrisma = {
      getClient: jest.fn().mockReturnValue(client),
    } as unknown as TenantPrismaService;
    const repository = new PrismaReceiptReviewRepository(tenantPrisma);
    const confirmedAt = new Date('2026-06-13T12:00:00.000Z');

    client.receiptEvidence.updateMany.mockResolvedValue({ count: 1 });
    const claimed = await repository.markConfirmed(
      'receipt-1',
      'tenant-1',
      'reviewer-1',
      confirmedAt,
    );

    expect(claimed).toBe(true);
    expect(client.receiptEvidence.updateMany).toHaveBeenCalledWith({
      where: { id: 'receipt-1', tenantId: 'tenant-1', status: 'PENDING' },
      data: {
        status: 'CONFIRMED',
        confirmedByUserId: 'reviewer-1',
        confirmedAt,
      },
    });
  });

  it('returns false when a confirmation or rejection conditional write loses', async () => {
    const client = makeMockPrisma();
    const tenantPrisma = {
      getClient: jest.fn().mockReturnValue(client),
    } as unknown as TenantPrismaService;
    const repository = new PrismaReceiptReviewRepository(tenantPrisma);

    client.receiptEvidence.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      repository.markConfirmed(
        'receipt-1',
        'tenant-1',
        'reviewer-1',
        new Date('2026-06-13T12:00:00.000Z'),
      ),
    ).resolves.toBe(false);
    await expect(
      repository.markRejected(
        'receipt-1',
        'tenant-1',
        'Unreadable receipt',
        'No pudimos leer tu comprobante.',
      ),
    ).resolves.toBe(false);

    expect(client.receiptEvidence.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'receipt-1', tenantId: 'tenant-1', status: 'PENDING' },
      data: {
        status: 'REJECTED',
        rejectionReason: 'Unreadable receipt',
        customerReason: 'No pudimos leer tu comprobante.',
      },
    });
  });
});
