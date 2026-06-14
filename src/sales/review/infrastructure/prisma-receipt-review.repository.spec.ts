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

  it('marks a receipt confirmed with reviewer attribution', async () => {
    const client = makeMockPrisma();
    const tenantPrisma = {
      getClient: jest.fn().mockReturnValue(client),
    } as unknown as TenantPrismaService;
    const repository = new PrismaReceiptReviewRepository(tenantPrisma);
    const confirmedAt = new Date('2026-06-13T12:00:00.000Z');

    await repository.markConfirmed(
      'receipt-1',
      'tenant-1',
      'reviewer-1',
      confirmedAt,
    );

    expect(client.receiptEvidence.updateMany).toHaveBeenCalledWith({
      where: { id: 'receipt-1', tenantId: 'tenant-1', status: 'PENDING' },
      data: {
        status: 'CONFIRMED',
        confirmedByUserId: 'reviewer-1',
        confirmedAt,
      },
    });
  });

  it('marks a receipt rejected with a reason', async () => {
    const client = makeMockPrisma();
    const tenantPrisma = {
      getClient: jest.fn().mockReturnValue(client),
    } as unknown as TenantPrismaService;
    const repository = new PrismaReceiptReviewRepository(tenantPrisma);

    await repository.markRejected(
      'receipt-1',
      'tenant-1',
      'Unreadable receipt',
    );

    expect(client.receiptEvidence.updateMany).toHaveBeenCalledWith({
      where: { id: 'receipt-1', tenantId: 'tenant-1', status: 'PENDING' },
      data: {
        status: 'REJECTED',
        rejectionReason: 'Unreadable receipt',
      },
    });
  });
});
