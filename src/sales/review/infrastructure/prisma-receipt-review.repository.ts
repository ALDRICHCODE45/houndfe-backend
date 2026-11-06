import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../../shared/prisma/tenant-prisma.service';
import type { ReceiptExtracted } from '../../../receipts/domain/receipt-fields';
import type { ReceiptMismatch } from '../../../receipts/domain/receipt-mismatch';
import type {
  ReceiptQueuePosition,
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
    folio: true,
    customer: { select: { firstName: true, lastName: true } },
  },
};

type PersistedReceiptReview = {
  id: string;
  saleId: string;
  tenantId: string;
  mediaUrl: string | null;
  declaredAmountCents: number | null;
  declaredDate: Date | null;
  declaredReference: string | null;
  storageKey?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  previewStatus?: string | null;
  extracted?: unknown;
  mismatch?: unknown;
  purgedAt?: Date | null;
  customerReason?: string | null;
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
    folio?: string | null;
    customer?: { firstName: string; lastName: string | null } | null;
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

  async findPendingForTenant(
    tenantId: string,
    page: { limit: number; after: ReceiptQueuePosition | null },
  ): Promise<ReceiptReviewRecord[]> {
    const { after } = page;
    const rows = await this.tenantPrisma.getClient().receiptEvidence.findMany({
      where: {
        tenantId,
        status: 'PENDING',
        sale: { status: 'CONFIRMED' },
        ...(after
          ? {
              OR: [
                { createdAt: { gt: after.createdAt } },
                { createdAt: after.createdAt, id: { gt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: page.limit,
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
  ): Promise<boolean> {
    const result = await this.tenantPrisma
      .getClient()
      .receiptEvidence.updateMany({
        where: { id: receiptId, tenantId, status: 'PENDING' },
        data: {
          status: 'CONFIRMED',
          confirmedByUserId: userId,
          confirmedAt: timestamp,
        },
      });

    return result.count > 0;
  }

  async markRejected(
    receiptId: string,
    tenantId: string,
    reason: string,
    customerReason: string,
  ): Promise<boolean> {
    const result = await this.tenantPrisma
      .getClient()
      .receiptEvidence.updateMany({
        where: { id: receiptId, tenantId, status: 'PENDING' },
        data: {
          status: 'REJECTED',
          rejectionReason: reason,
          customerReason,
        },
      });

    return result.count > 0;
  }
}

function mapReceiptReviewRecord(
  row: PersistedReceiptReview,
): ReceiptReviewRecord {
  return {
    id: row.id,
    saleId: row.saleId,
    tenantId: row.tenantId,
    // Private uploads keep the strict v1 shape: '' means "no public URL" (see
    // `file`) and 0 means "not declared" (see `declaredAmountProvided`).
    mediaUrl: row.mediaUrl ?? '',
    declaredAmountCents: row.declaredAmountCents ?? 0,
    declaredAmountProvided: row.declaredAmountCents !== null,
    declaredDate: row.declaredDate,
    declaredReference: row.declaredReference,
    status: row.status as ReceiptReviewStatus,
    confirmedByUserId: row.confirmedByUserId,
    confirmedAt: row.confirmedAt,
    rejectionReason: row.rejectionReason,
    customerReason: row.customerReason ?? null,
    createdAt: row.createdAt,
    file: mapFile(row),
    extracted: (row.extracted ?? null) as ReceiptExtracted | null,
    mismatch: (row.mismatch ?? null) as ReceiptMismatch | null,
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
      folio: row.sale.folio ?? null,
      customerName: row.sale.customer
        ? [row.sale.customer.firstName, row.sale.customer.lastName]
            .filter(Boolean)
            .join(' ')
        : null,
    },
  };
}

/** Private uploads always store mimeType; legacy URL rows never do. */
function mapFile(row: PersistedReceiptReview): ReceiptReviewRecord['file'] {
  if (!row.mimeType) return null;
  return {
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes ?? null,
    previewStatus: row.previewStatus === 'READY' ? 'READY' : 'UNAVAILABLE',
    purged: row.purgedAt != null,
  };
}
