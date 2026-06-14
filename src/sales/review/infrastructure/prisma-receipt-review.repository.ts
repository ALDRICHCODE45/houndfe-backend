import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../../shared/prisma/tenant-prisma.service';
import type {
  ReceiptReviewRecord,
  ReceiptReviewRepository,
  ReceiptReviewStatus,
} from '../domain/receipt-review.repository';

const receiptSaleInclude = {
  select: {
    id: true,
    status: true,
    paymentStatus: true,
    paidCents: true,
    debtCents: true,
    totalCents: true,
    channel: true,
  },
};

type PersistedReceiptReview = {
  id: string;
  saleId: string;
  tenantId: string;
  mediaUrl: string;
  declaredAmountCents: number;
  declaredDate: Date | null;
  declaredReference: string | null;
  status: string;
  confirmedByUserId: string | null;
  confirmedAt: Date | null;
  rejectionReason: string | null;
  createdAt: Date;
  sale: {
    id: string;
    status: string;
    paymentStatus: string | null;
    paidCents: number;
    debtCents: number;
    totalCents: number;
    channel: string;
  };
};

@Injectable()
export class PrismaReceiptReviewRepository implements ReceiptReviewRepository {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async findPendingForSale(
    saleId: string,
    tenantId: string,
  ): Promise<ReceiptReviewRecord[]> {
    const rows = await this.tenantPrisma.getClient().receiptEvidence.findMany({
      where: {
        saleId,
        tenantId,
        status: 'PENDING',
        sale: { status: 'CONFIRMED' },
      },
      orderBy: { createdAt: 'asc' },
      include: { sale: receiptSaleInclude },
    });

    return rows.map(mapReceiptReviewRecord);
  }

  async findById(
    receiptId: string,
    tenantId: string,
  ): Promise<ReceiptReviewRecord | null> {
    const row = await this.tenantPrisma.getClient().receiptEvidence.findFirst({
      where: { id: receiptId, tenantId },
      include: { sale: receiptSaleInclude },
    });

    return row ? mapReceiptReviewRecord(row) : null;
  }

  async markConfirmed(
    receiptId: string,
    tenantId: string,
    userId: string,
    timestamp: Date,
  ): Promise<void> {
    await this.tenantPrisma.getClient().receiptEvidence.updateMany({
      where: { id: receiptId, tenantId, status: 'PENDING' },
      data: {
        status: 'CONFIRMED',
        confirmedByUserId: userId,
        confirmedAt: timestamp,
      },
    });
  }

  async markRejected(
    receiptId: string,
    tenantId: string,
    reason: string,
  ): Promise<void> {
    await this.tenantPrisma.getClient().receiptEvidence.updateMany({
      where: { id: receiptId, tenantId, status: 'PENDING' },
      data: {
        status: 'REJECTED',
        rejectionReason: reason,
      },
    });
  }
}

function mapReceiptReviewRecord(
  row: PersistedReceiptReview,
): ReceiptReviewRecord {
  return {
    id: row.id,
    saleId: row.saleId,
    tenantId: row.tenantId,
    mediaUrl: row.mediaUrl,
    declaredAmountCents: row.declaredAmountCents,
    declaredDate: row.declaredDate,
    declaredReference: row.declaredReference,
    status: row.status as ReceiptReviewStatus,
    confirmedByUserId: row.confirmedByUserId,
    confirmedAt: row.confirmedAt,
    rejectionReason: row.rejectionReason,
    createdAt: row.createdAt,
    sale: {
      id: row.sale.id,
      status: row.sale.status as 'DRAFT' | 'CONFIRMED',
      paymentStatus: row.sale.paymentStatus as
        | 'PAID'
        | 'PARTIAL'
        | 'CREDIT'
        | null,
      paidCents: row.sale.paidCents,
      debtCents: row.sale.debtCents,
      totalCents: row.sale.totalCents,
      channel: row.sale.channel as 'POS' | 'ONLINE',
    },
  };
}
